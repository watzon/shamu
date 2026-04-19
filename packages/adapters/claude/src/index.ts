// `@shamu/adapter-claude` — production AgentAdapter on
// `@anthropic-ai/claude-agent-sdk@0.2.113`.
//
// Design notes:
// - Uses `query()` for one-shot runs. The returned `Query` is async-iterable
//   and exposes `interrupt`/`setModel`/`setPermissionMode`/`rewindFiles`.
// - Uses `unstable_v2_createSession` + `.send()` + `.stream()` for warm
//   resume. Phase 0.A confirmed `ClaudeSDKClient` is NOT exported in 0.2.113.
// - Capability manifest loaded from `capabilities.json`, frozen at
//   construction (G8 from threat model).
// - Redaction (G1) is applied by the handle before events are enqueued.
// - Path-scope (G4) and shell AST (G5) gates are wired via the permission
//   handler; the `canUseTool` callback runs BEFORE the tool executes.
// - Cache-key (T9) composition lives in `./cache-key.ts`; we include `runId`
//   and the system-prompt hash so two runs with different prompts do not
//   share a cache hit. The resulting salt is threaded through as `env`
//   (`SHAMU_CACHE_SALT`) so the CLI subprocess hashes the prefix the same
//   way. Contract-tested.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CanUseTool,
  type Options as ClaudeOptions,
  type McpSdkServerConfigWithInstance,
  type PermissionResult,
  query,
  type SDKSession,
  type Query as SdkQuery,
  unstable_v2_createSession,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentAdapter,
  type AgentHandle,
  type Capabilities,
  freezeCapabilities,
  type MonotonicClock,
  type SpawnOpts,
} from "@shamu/adapters-base";
import type { ShellGatePolicy } from "@shamu/adapters-base/shell-gate";
import type { EventId, SessionId } from "@shamu/shared/ids";
import { Redactor } from "@shamu/shared/redactor";
import { composeCacheKey, hashMcpServer, hashString } from "./cache-key.ts";
import {
  type ClaudeDriver,
  ClaudeHandle,
  type ClaudeQueryLike,
  type ClaudeSessionLike,
} from "./handle.ts";
import type { ClaudeHookInput, ClaudeRaw } from "./hooks.ts";
import { createPermissionHandler } from "./permission-handler.ts";

export type { CacheKeyInputs } from "./cache-key.ts";
export { composeCacheKey, hashMcpServer, hashString } from "./cache-key.ts";
export type { ClaudeDriver, ClaudeQueryLike, ClaudeSessionLike } from "./handle.ts";
export type { ClaudeHookInput, ClaudeRaw } from "./hooks.ts";
export type { PermissionDecision } from "./permission-handler.ts";
export {
  type EnsureClaudeSidecarOptions,
  type EnsureClaudeSidecarResult,
  ensureClaudeSidecar,
  type FetchFn as SidecarFetchFn,
  type SidecarFs,
} from "./sidecar.ts";
export {
  SIDECAR_DOWNLOAD_URL_TEMPLATE,
  SIDECAR_PINS,
  SIDECAR_VERSION,
  type SidecarPlatform,
} from "./sidecar-pins.ts";

function loadClaudeCapabilities(): Readonly<Capabilities> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "capabilities.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return freezeCapabilities(raw);
}

/**
 * The Claude adapter's immutable capability manifest. Loaded once at module
 * load — per G8 the adapter cannot vary capabilities at runtime.
 */
export const CLAUDE_CAPABILITIES: Readonly<Capabilities> = loadClaudeCapabilities();

export interface ClaudeAdapterOptions {
  /** Override the monotonic clock for deterministic tests. */
  readonly clock?: MonotonicClock;
  /** Override the ULID factory for deterministic tests. */
  readonly newEventId?: () => EventId;
  /** Inject a pre-populated redactor (register planted secrets, etc.). */
  readonly redactor?: Redactor;
  /** Rename the vendor tag. Defaults to `"claude"`. */
  readonly vendor?: string;
  /**
   * Driver factory — in production, defaults to a thin wrapper over
   * `query()` / `unstable_v2_createSession`. Tests supply a scripted double.
   */
  readonly driverFactory?: ClaudeDriverFactory;
}

/**
 * Per-spawn `vendorOpts` recognized by this adapter. Adapters are allowed
 * to declare a narrower type via module augmentation — we choose to surface
 * an explicit interface for readability.
 */
export interface ClaudeVendorOpts {
  /** Optional in-process MCP server. Wired into `query()` as `mcpServers`. */
  readonly mcpServer?: McpSdkServerConfigWithInstance;
  /**
   * System prompt override. The cache-key composition hashes this string;
   * any change invalidates the prompt-cache prefix (T9).
   */
  readonly systemPrompt?: string;
  /**
   * Shell-gate policy override for the `Bash` tool. Default: base
   * `DEFAULT_POLICY` (structural reject-list, no allow-list).
   */
  readonly shellPolicy?: ShellGatePolicy;
  /**
   * Max output turns before the SDK stops. Mirrors `Options.maxTurns` —
   * surfaced here so the orchestrator doesn't need to reach for the full
   * `Options` grab-bag.
   */
  readonly maxTurns?: number;
  /**
   * Anthropic-style cache-control behavior flag. We always salt with
   * runId+systemPromptHash+mcpServerHash; this flag selects how the salt is
   * plumbed — `"env"` exports `SHAMU_CACHE_SALT`, `"prompt"` prepends an
   * invisible token to the system prompt. Default: `"env"`.
   */
  readonly cacheSaltStrategy?: "env" | "prompt";
}

/**
 * Function returning a driver for a new handle. Injection point for tests;
 * production passes the default `realDriverFactory`.
 */
export type ClaudeDriverFactory = (ctx: DriverContext) => Promise<ClaudeDriver>;

export interface DriverContext {
  readonly sessionId: SessionId | null;
  readonly spawnOpts: SpawnOpts;
  readonly claudeOptions: ClaudeOptions;
}

// --- default driver (real SDK) --------------------------------------------

/**
 * Adapter that wraps the SDK's `Query` in our structural `ClaudeQueryLike`
 * interface. The only real work here is pass-through.
 */
function toClaudeQueryLike(q: SdkQuery): ClaudeQueryLike {
  // The SDK's Query is `AsyncGenerator<SDKMessage, void>`; our ClaudeRaw
  // type is a looser view of the same shape, so the structural assignment
  // works via explicit iterable wrapping.
  return {
    [Symbol.asyncIterator]: () => {
      const iter = q[Symbol.asyncIterator]();
      const innerReturn = iter.return?.bind(iter);
      return {
        next: async () => {
          const step = await iter.next();
          if (step.done) return { value: undefined as unknown as ClaudeRaw, done: true };
          return { value: step.value as unknown as ClaudeRaw, done: false };
        },
        return: innerReturn
          ? (value) => innerReturn(value) as Promise<IteratorResult<ClaudeRaw>>
          : undefined,
      } as AsyncIterator<ClaudeRaw>;
    },
    interrupt: () => q.interrupt(),
    setModel: (model) => q.setModel(model),
    setPermissionMode: (mode) => q.setPermissionMode(mode),
  };
}

function toClaudeSessionLike(s: SDKSession): ClaudeSessionLike {
  return {
    get sessionId() {
      return s.sessionId;
    },
    send: (message) => s.send(message),
    stream: () => {
      const iter = s.stream();
      return {
        [Symbol.asyncIterator]: () => {
          const inner = iter[Symbol.asyncIterator]();
          return {
            next: async () => {
              const step = await inner.next();
              if (step.done) return { value: undefined as unknown as ClaudeRaw, done: true };
              return { value: step.value as unknown as ClaudeRaw, done: false };
            },
          } as AsyncIterator<ClaudeRaw>;
        },
      };
    },
    close: () => s.close(),
  };
}

/**
 * The default driver factory — spawns a real Claude subprocess via the SDK.
 * Only exported for advanced integrators; tests generally supply their own
 * factory so they never touch the vendor binary.
 */
export const realDriverFactory: ClaudeDriverFactory = async (ctx) => {
  const session: SDKSession | null = ctx.sessionId
    ? unstable_v2_createSession({
        ...(ctx.claudeOptions as unknown as Parameters<typeof unstable_v2_createSession>[0]),
      })
    : null;
  const clientSession = session ? toClaudeSessionLike(session) : null;

  return {
    session: clientSession,
    async startQuery(prompt, signal): Promise<ClaudeQueryLike> {
      const opts: ClaudeOptions = {
        ...ctx.claudeOptions,
        abortController: signalToController(signal),
      };
      const q = query({ prompt, options: opts });
      return toClaudeQueryLike(q);
    },
    async sendOnSession(s, prompt) {
      await s.send(prompt);
      return s.stream();
    },
  };
};

/** Wrap an external `AbortSignal` in an AbortController for the SDK. */
function signalToController(signal: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (signal.aborted) ctrl.abort();
  else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  return ctrl;
}

// --- adapter --------------------------------------------------------------

export class ClaudeAdapter implements AgentAdapter {
  public readonly vendor: string;
  public readonly capabilities: Readonly<Capabilities> = CLAUDE_CAPABILITIES;

  private readonly clock: MonotonicClock | undefined;
  private readonly newEventIdFactory: (() => EventId) | undefined;
  private readonly redactor: Redactor;
  private readonly driverFactory: ClaudeDriverFactory;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.vendor = options.vendor ?? "claude";
    this.clock = options.clock;
    this.newEventIdFactory = options.newEventId;
    this.redactor = options.redactor ?? new Redactor();
    this.driverFactory = options.driverFactory ?? realDriverFactory;
  }

  async spawn(opts: SpawnOpts): Promise<AgentHandle> {
    return this.makeHandle(null, "spawn", opts);
  }

  async resume(sessionId: SessionId, opts: SpawnOpts): Promise<AgentHandle> {
    return this.makeHandle(sessionId, "resume", opts);
  }

  private async makeHandle(
    sessionId: SessionId | null,
    sessionSource: "spawn" | "resume",
    spawnOpts: SpawnOpts,
  ): Promise<AgentHandle> {
    const vendorOpts = (spawnOpts.vendorOpts ?? {}) as ClaudeVendorOpts;

    const currentModel = spawnOpts.model ?? "claude-opus-4-7";
    const systemPrompt = vendorOpts.systemPrompt ?? "";
    const mcpServer = vendorOpts.mcpServer;
    const cacheSalt = composeCacheKey({
      runId: spawnOpts.runId,
      systemPromptHash: hashString(systemPrompt),
      ...(mcpServer ? { mcpServerHash: hashMcpServer(mcpServer) } : {}),
      model: currentModel,
    });

    const shellPolicy = vendorOpts.shellPolicy;
    const claudeOptions = this.buildClaudeOptions({
      spawnOpts,
      sessionId,
      systemPrompt,
      mcpServer,
      currentModel,
      shellPolicy,
      cacheSalt,
      vendorOpts,
    });

    const driver = await this.driverFactory({ sessionId, spawnOpts, claudeOptions });

    const handle = new ClaudeHandle({
      vendor: this.vendor,
      sessionSource,
      initialSessionId: sessionId,
      ...(this.clock ? { clock: this.clock } : {}),
      ...(this.newEventIdFactory ? { newEventId: this.newEventIdFactory } : {}),
      redactor: this.redactor,
      spawnOpts,
      driver,
      currentModel,
    });

    // Defensive: the handle must honor the orchestrator-supplied runId.
    if (handle.runId !== spawnOpts.runId) {
      throw new Error(
        `ClaudeAdapter: handle.runId=${handle.runId} does not match opts.runId=${spawnOpts.runId} (G8)`,
      );
    }

    // Expose a helper so callers (or the driver factory) can forward hook
    // callbacks into the handle. Not part of the AgentHandle interface; used
    // by the default driver below and by tests that drive hooks directly.
    (handle as unknown as { __projectHook: (h: ClaudeHookInput) => void }).__projectHook = (
      h: ClaudeHookInput,
    ) => handle.projectHook(h);

    return handle;
  }

  /**
   * Assemble the Claude SDK `Options` for a spawn. Kept small: most of the
   * SDK's 100+ fields are pass-through when the caller sets `vendorOpts`.
   */
  private buildClaudeOptions(input: {
    spawnOpts: SpawnOpts;
    sessionId: SessionId | null;
    systemPrompt: string;
    mcpServer: McpSdkServerConfigWithInstance | undefined;
    currentModel: string;
    shellPolicy: ShellGatePolicy | undefined;
    cacheSalt: string;
    vendorOpts: ClaudeVendorOpts;
  }): ClaudeOptions {
    const {
      spawnOpts,
      sessionId,
      systemPrompt,
      mcpServer,
      currentModel,
      shellPolicy,
      cacheSalt,
      vendorOpts,
    } = input;

    const handler = createPermissionHandler({
      worktreeRoot: spawnOpts.cwd,
      ...(shellPolicy ? { shellPolicy } : {}),
    });
    const canUseTool: CanUseTool = async (toolName, toolInput) => {
      const decision = handler(toolName, toolInput);
      if (decision.behavior === "allow") {
        return { behavior: "allow" } satisfies PermissionResult;
      }
      return {
        behavior: "deny",
        message: decision.message,
        ...(decision.interrupt ? { interrupt: true } : {}),
      } satisfies PermissionResult;
    };

    const saltStrategy = vendorOpts.cacheSaltStrategy ?? "env";
    const envMap: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      USER: process.env.USER,
    };
    if (saltStrategy === "env") envMap.SHAMU_CACHE_SALT = cacheSalt;
    // SpawnOpts.env merges on top of the adapter's allow-list. Empty strings
    // delete a key (standard env-merge semantics). Primary use: the egress
    // broker injects HTTPS_PROXY/HTTP_PROXY/NO_PROXY here at spawn time.
    if (spawnOpts.env) {
      for (const [k, v] of Object.entries(spawnOpts.env)) {
        if (typeof v !== "string") continue;
        if (v.length === 0) {
          delete envMap[k];
          continue;
        }
        envMap[k] = v;
      }
    }

    const effectiveSystemPrompt =
      saltStrategy === "prompt" && systemPrompt.length > 0
        ? `${systemPrompt}\n\n<!-- shamu-cache-salt:${cacheSalt} -->`
        : systemPrompt.length > 0
          ? systemPrompt
          : undefined;

    const opts: ClaudeOptions = {
      cwd: spawnOpts.cwd,
      model: currentModel,
      env: envMap,
      ...(spawnOpts.permissionMode ? { permissionMode: spawnOpts.permissionMode } : {}),
      ...(spawnOpts.vendorCliPath ? { pathToClaudeCodeExecutable: spawnOpts.vendorCliPath } : {}),
      ...(spawnOpts.maxTurns !== undefined ? { maxTurns: spawnOpts.maxTurns } : {}),
      ...(vendorOpts.maxTurns !== undefined ? { maxTurns: vendorOpts.maxTurns } : {}),
      ...(spawnOpts.allowedTools !== undefined
        ? { allowedTools: [...spawnOpts.allowedTools] }
        : {}),
      ...(effectiveSystemPrompt !== undefined ? { systemPrompt: effectiveSystemPrompt } : {}),
      ...(mcpServer ? { mcpServers: { shamu: mcpServer } } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      canUseTool,
    };
    return opts;
  }
}

/** Convenience: a live adapter instance with default options. */
export function createClaudeAdapter(options?: ClaudeAdapterOptions): ClaudeAdapter {
  return new ClaudeAdapter(options);
}
