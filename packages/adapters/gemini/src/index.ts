/**
 * `@shamu/adapter-gemini` — production `AgentAdapter` for Gemini.
 *
 * The ACP-stdio variation adapter for Phase 7.C. Speaks JSON-RPC 2.0 over
 * stdin/stdout with a locally-spawned `gemini --acp` subprocess (from
 * `@google/gemini-cli`, installed globally by the user; no runtime
 * dependency). Transport + method dictionary live in `@shamu/protocol-acp`;
 * this package owns auth, capability declaration, permission policy, and
 * the projection of ACP `session/update` notifications into Shamu's
 * `AgentEvent` union.
 *
 * ### Lifecycle
 *
 *   new GeminiAdapter()
 *     → .spawn(opts) / .resume(sid, opts)
 *       → driverFactory(driverOpts)           — spawns the subprocess
 *       → client.initialize(...)
 *       → applyGeminiAuth(client, ...)        — optional
 *       → client.newSession(...) OR client.loadSession(...)
 *       → new GeminiHandle({ ... })
 *
 *   handle.send({ text })
 *     → client.prompt({ sessionId, prompt: [...] })
 *     → on result: emit usage + cost + turn_end
 *     → on notification: projector → event queue
 *
 *   handle.setModel("gemini-2.5-pro")
 *     → client.sendRequest("unstable_setSessionModel", { sessionId, model })
 *     → graceful fallback: emits non-fatal `error` on RPC failure, still
 *       stamps the requested model on subsequent `usage` events
 *
 *   handle.shutdown(reason)
 *     → emit session_end
 *     → driver.close()                        — reaps the subprocess
 *     → unsubscribe client handlers
 *     → close event queue
 *
 * ### Auth (see `auth.ts`)
 *
 * Precedence: `vendorOpts.apiKey` → `GEMINI_API_KEY` env →
 * `GOOGLE_AI_API_KEY` env → skip (rely on already-logged-in `gemini
 * /login`).
 *
 * ### Vendor path resolution (see `driver.ts`)
 *
 * `opts.vendorCliPath` → `GEMINI_CLI_PATH` env → `Bun.which("gemini")` →
 * `$PATH` scan. Missing binary surfaces `SpawnError` pointing at the
 * `npm install -g @google/gemini-cli` install path.
 *
 * ### Known upstream bug
 *
 * gemini-cli#22647: non-ACP writes can bleed into the JSON-RPC stream.
 * Protocol-acp's line validator catches every malformed line and fires
 * `onProtocolError`; the handle maps each to a non-fatal `error`
 * `AgentEvent` with `errorCode: "acp_protocol"`. Runs stay alive.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentAdapter,
  type AgentHandle,
  type Capabilities,
  freezeCapabilities,
  type MonotonicClock,
  type SpawnOpts,
} from "@shamu/adapters-base";
import type { AcpClientOptions } from "@shamu/protocol-acp";
import type { EventId, SessionId, ToolCallId, TurnId } from "@shamu/shared/ids";
import type { Redactor } from "@shamu/shared/redactor";
import { applyGeminiAuth, type GeminiAuthOptions } from "./auth.ts";
import { createRealGeminiDriver, type GeminiDriver, type GeminiDriverOptions } from "./driver.ts";
import { GeminiHandle } from "./handle.ts";

export type { GeminiAuthOptions } from "./auth.ts";
export { applyGeminiAuth, GeminiAuthError, resolveAuth } from "./auth.ts";
export {
  createRealGeminiDriver,
  type GeminiDriver,
  type GeminiDriverOptions,
  resolveGeminiBinaryPath,
} from "./driver.ts";
export type { GeminiHandleOptions } from "./handle.ts";
export { GeminiHandle } from "./handle.ts";
export {
  decideGeminiPermission,
  type GeminiPermissionOptions,
  type GeminiPolicyDecision,
} from "./permission-handler.ts";
export {
  createProjectionState,
  type ProjectionContext,
  type ProjectionHooks,
  type ProjectionState,
  projectGeminiEvent,
} from "./projection.ts";
export { geminiVendorCliDescriptor } from "./vendor-cli-descriptor.ts";

const DEFAULT_VENDOR = "gemini";

function loadGeminiCapabilities(): Readonly<Capabilities> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "capabilities.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return freezeCapabilities(raw);
}

/**
 * Frozen capability manifest. Loaded once at module load; every handle
 * shares this reference. Capabilities are immutable at runtime (G8).
 */
export const GEMINI_CAPABILITIES: Readonly<Capabilities> = loadGeminiCapabilities();

/** Per-spawn vendor options recognized by the Gemini adapter. */
export interface GeminiVendorOpts {
  /** Direct API key (preferred over env). */
  readonly apiKey?: string;
  /**
   * Extra args appended to `gemini --acp` at spawn. Test / debug only.
   */
  readonly extraArgs?: readonly string[];
  /** Per-turn `session/prompt` watchdog timeout. Default 10 minutes. */
  readonly promptTimeoutMs?: number;
  /** ACP-level client options forwarded to `createAcpClient`. */
  readonly clientOptions?: AcpClientOptions;
  /**
   * Allow-listed env passed to the subprocess. Merged with the adapter's
   * defaults (PATH/HOME/LANG/USER/XDG_*).
   */
  readonly env?: Readonly<Record<string, string>>;
  /** SIGKILL fallback delay for `driver.close()`. Default 2000 ms. */
  readonly sigkillTimeoutMs?: number;
}

export interface GeminiAdapterOptions {
  /** Factory for the `GeminiDriver`. Tests pass a scripted double. */
  readonly driverFactory?: (opts: GeminiDriverOptions) => Promise<GeminiDriver>;
  readonly clock?: MonotonicClock;
  readonly newEventId?: () => EventId;
  readonly newTurnId?: () => TurnId;
  readonly newToolCallId?: () => ToolCallId;
  readonly redactor?: Redactor;
  readonly vendor?: string;
  /**
   * Supply a protocol version for `initialize`. The ACP spec's current
   * version is `1`; we default to that.
   */
  readonly protocolVersion?: number;
  /** Client info advertised in `initialize`. */
  readonly clientInfo?: Readonly<{ name: string; version?: string }>;
}

export class GeminiAdapter implements AgentAdapter {
  public readonly vendor: string;
  public readonly capabilities: Readonly<Capabilities> = GEMINI_CAPABILITIES;

  private readonly driverFactory: (opts: GeminiDriverOptions) => Promise<GeminiDriver>;
  private readonly clock: MonotonicClock | undefined;
  private readonly newEventIdFactory: (() => EventId) | undefined;
  private readonly newTurnIdFactory: (() => TurnId) | undefined;
  private readonly newToolCallIdFactory: (() => ToolCallId) | undefined;
  private readonly redactor: Redactor | undefined;
  private readonly protocolVersion: number;
  private readonly clientInfo: Readonly<{ name: string; version?: string }>;

  constructor(options: GeminiAdapterOptions = {}) {
    this.vendor = options.vendor ?? DEFAULT_VENDOR;
    this.driverFactory = options.driverFactory ?? createRealGeminiDriver;
    this.clock = options.clock;
    this.newEventIdFactory = options.newEventId;
    this.newTurnIdFactory = options.newTurnId;
    this.newToolCallIdFactory = options.newToolCallId;
    this.redactor = options.redactor;
    this.protocolVersion = options.protocolVersion ?? 1;
    this.clientInfo = options.clientInfo ?? { name: "shamu", version: "0.0.0" };
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
    opts: SpawnOpts,
  ): Promise<AgentHandle> {
    const vendorOpts = (opts.vendorOpts ?? {}) as GeminiVendorOpts;
    // `SpawnOpts.env` merges on top of `vendorOpts.env`. Broker-supplied
    // HTTPS_PROXY/HTTP_PROXY/NO_PROXY (per-run) win over the caller's
    // vendor-specific allow-list; the driver's `defaultEnv` then merges the
    // result on top of the PATH/HOME/XDG_* passthrough. Empty-string values
    // delete a key (standard env-merge semantics).
    const mergedEnv = mergeCallerEnv(vendorOpts.env, opts.env);
    const driverOpts: GeminiDriverOptions = {
      ...(opts.vendorCliPath !== undefined ? { vendorCliPath: opts.vendorCliPath } : {}),
      cwd: opts.cwd,
      ...(mergedEnv !== undefined ? { env: mergedEnv } : {}),
      ...(vendorOpts.extraArgs !== undefined ? { extraArgs: vendorOpts.extraArgs } : {}),
      ...(vendorOpts.sigkillTimeoutMs !== undefined
        ? { sigkillTimeoutMs: vendorOpts.sigkillTimeoutMs }
        : {}),
      ...(vendorOpts.clientOptions !== undefined
        ? { clientOptions: vendorOpts.clientOptions }
        : {}),
    };

    const driver = await this.driverFactory(driverOpts);
    try {
      await driver.client.initialize({
        protocolVersion: this.protocolVersion,
        clientInfo: this.clientInfo,
        clientCapabilities: {},
      });
      const authOpts: GeminiAuthOptions = {
        ...(vendorOpts.apiKey !== undefined ? { apiKey: vendorOpts.apiKey } : {}),
      };
      await applyGeminiAuth(driver.client, authOpts);

      let vendorSessionId: SessionId;
      if (sessionId) {
        await driver.client.loadSession({ sessionId, cwd: opts.cwd });
        vendorSessionId = sessionId;
      } else {
        const result = await driver.client.newSession({ cwd: opts.cwd });
        if (!result.sessionId) {
          throw new Error("GeminiAdapter: session/new returned no sessionId");
        }
        vendorSessionId = result.sessionId as SessionId;
      }

      const handle = new GeminiHandle({
        driver,
        opts,
        vendor: this.vendor,
        capabilities: this.capabilities,
        vendorSessionId,
        sessionSource,
        ...(this.clock ? { clock: this.clock } : {}),
        ...(this.newEventIdFactory ? { newEventId: this.newEventIdFactory } : {}),
        ...(this.newTurnIdFactory ? { newTurnId: this.newTurnIdFactory } : {}),
        ...(this.newToolCallIdFactory ? { newToolCallId: this.newToolCallIdFactory } : {}),
        ...(this.redactor ? { redactor: this.redactor } : {}),
        ...(vendorOpts.promptTimeoutMs !== undefined
          ? { promptTimeoutMs: vendorOpts.promptTimeoutMs }
          : {}),
      });

      // Defensive G8 invariant — handle.runId must equal opts.runId.
      if (handle.runId !== opts.runId) {
        throw new Error(
          `GeminiAdapter: handle.runId=${handle.runId} does not match opts.runId=${opts.runId} (G8)`,
        );
      }
      return handle;
    } catch (cause) {
      // Spawn rollback — we own the driver in the failure path.
      try {
        await driver.close();
      } catch {
        // ignore
      }
      throw cause;
    }
  }
}

/** Convenience factory. */
export function createGeminiAdapter(options: GeminiAdapterOptions = {}): GeminiAdapter {
  return new GeminiAdapter(options);
}

/**
 * Structural shape every adapter's `listModels()` returns. Kept inline so
 * `@shamu/adapters-base` does not need a schema change (9.C narrow-edit
 * constraint).
 */
export interface ModelInfo {
  readonly id: string;
  readonly label: string;
  readonly default?: boolean;
}

/**
 * Gemini model catalog. Sourced from `@google/gemini-cli`'s supported
 * model list (README). Default tracks the CLI's implicit default.
 */
export function listModels(): readonly ModelInfo[] {
  return [
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", default: true },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { id: "gemini-2.0-pro", label: "Gemini 2.0 Pro" },
  ];
}

/**
 * Merge `SpawnOpts.env` on top of `vendorOpts.env` with empty-string = delete
 * semantics. Returns `undefined` when neither side contributes a key. The
 * driver's own `defaultEnv` then layers the result on top of the
 * PATH/HOME/XDG_* passthrough.
 */
function mergeCallerEnv(
  vendorEnv: Readonly<Record<string, string>> | undefined,
  spawnEnv: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (!vendorEnv && !spawnEnv) return undefined;
  const out: Record<string, string> = {};
  if (vendorEnv) {
    for (const [k, v] of Object.entries(vendorEnv)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  if (spawnEnv) {
    for (const [k, v] of Object.entries(spawnEnv)) {
      if (typeof v !== "string") continue;
      if (v.length === 0) {
        delete out[k];
        continue;
      }
      out[k] = v;
    }
  }
  return out;
}
