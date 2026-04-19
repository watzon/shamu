/**
 * `@shamu/adapter-cursor` — production `AgentAdapter` for Cursor.
 *
 * The ACP-stdio reference adapter for Phase 7.B. Speaks JSON-RPC 2.0 over
 * stdin/stdout with a locally-spawned `cursor-agent acp` subprocess.
 * Transport + method dictionary live in `@shamu/protocol-acp`; this
 * package owns auth, capability declaration, permission policy, and the
 * projection of ACP `session/update` notifications into Shamu's
 * `AgentEvent` union.
 *
 * ### Lifecycle
 *
 *   new CursorAdapter()
 *     → .spawn(opts) / .resume(sid, opts)
 *       → driverFactory(driverOpts)            — spawns the subprocess
 *       → client.initialize(...)
 *       → applyCursorAuth(client, ...)         — optional
 *       → client.newSession(...) OR client.loadSession(...)
 *       → new CursorHandle({ ... })
 *
 *   handle.send({ text })
 *     → client.prompt({ sessionId, prompt: [...] })
 *     → on result: emit usage + cost + turn_end
 *     → on notification: projector → event queue
 *
 *   handle.shutdown(reason)
 *     → emit session_end
 *     → driver.close()                        — reaps the subprocess
 *     → unsubscribe client handlers
 *     → close event queue
 *
 * ### Auth (see `auth.ts`)
 *
 * Precedence: `vendorOpts.apiKey` → `vendorOpts.authToken` →
 * `CURSOR_API_KEY` env → `CURSOR_AUTH_TOKEN` env → skip (rely on already-
 * logged-in Cursor Desktop).
 *
 * ### Vendor path resolution (see `driver.ts`)
 *
 * `opts.vendorCliPath` → `CURSOR_AGENT_PATH` → `~/.local/bin/agent`.
 * Missing binary surfaces `SpawnError` with a "see shamu doctor" hint.
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
import { applyCursorAuth, type CursorAuthOptions } from "./auth.ts";
import { type CursorDriver, type CursorDriverOptions, createRealCursorDriver } from "./driver.ts";
import { CursorHandle } from "./handle.ts";

export type { CursorAuthOptions } from "./auth.ts";
export { applyCursorAuth, CursorAuthError, resolveAuth } from "./auth.ts";
export {
  type CursorDriver,
  type CursorDriverOptions,
  createRealCursorDriver,
  resolveCursorBinaryPath,
} from "./driver.ts";
export type { CursorHandleOptions } from "./handle.ts";
export { CursorHandle } from "./handle.ts";
export {
  type CursorPermissionOptions,
  type CursorPolicyDecision,
  decideCursorPermission,
} from "./permission-handler.ts";
export {
  createProjectionState,
  type ProjectionContext,
  type ProjectionHooks,
  type ProjectionState,
  projectCursorEvent,
} from "./projection.ts";
export { cursorVendorCliDescriptor } from "./vendor-cli-descriptor.ts";

const DEFAULT_VENDOR = "cursor";

function loadCursorCapabilities(): Readonly<Capabilities> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "capabilities.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return freezeCapabilities(raw);
}

/**
 * Frozen capability manifest. Loaded once at module load; every handle
 * shares this reference. Capabilities are immutable at runtime (G8).
 */
export const CURSOR_CAPABILITIES: Readonly<Capabilities> = loadCursorCapabilities();

/** Per-spawn vendor options recognized by the Cursor adapter. */
export interface CursorVendorOpts {
  /** Direct API key (preferred over env). */
  readonly apiKey?: string;
  /** Subscription auth token (Cursor Desktop's persisted credential). */
  readonly authToken?: string;
  /**
   * Extra args appended to `cursor-agent acp` at spawn. Test / debug only.
   */
  readonly extraArgs?: readonly string[];
  /** Per-turn `session/prompt` watchdog timeout. Default 10 minutes. */
  readonly promptTimeoutMs?: number;
  /** Override the session title passed to `session/new`. */
  readonly sessionTitle?: string;
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

export interface CursorAdapterOptions {
  /** Factory for the `CursorDriver`. Tests pass a scripted double. */
  readonly driverFactory?: (opts: CursorDriverOptions) => Promise<CursorDriver>;
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

export class CursorAdapter implements AgentAdapter {
  public readonly vendor: string;
  public readonly capabilities: Readonly<Capabilities> = CURSOR_CAPABILITIES;

  private readonly driverFactory: (opts: CursorDriverOptions) => Promise<CursorDriver>;
  private readonly clock: MonotonicClock | undefined;
  private readonly newEventIdFactory: (() => EventId) | undefined;
  private readonly newTurnIdFactory: (() => TurnId) | undefined;
  private readonly newToolCallIdFactory: (() => ToolCallId) | undefined;
  private readonly redactor: Redactor | undefined;
  private readonly protocolVersion: number;
  private readonly clientInfo: Readonly<{ name: string; version?: string }>;

  constructor(options: CursorAdapterOptions = {}) {
    this.vendor = options.vendor ?? DEFAULT_VENDOR;
    this.driverFactory = options.driverFactory ?? createRealCursorDriver;
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
    const vendorOpts = (opts.vendorOpts ?? {}) as CursorVendorOpts;
    // `SpawnOpts.env` merges on top of `vendorOpts.env`. Broker-supplied
    // HTTPS_PROXY/HTTP_PROXY/NO_PROXY (per-run) win over the caller's
    // vendor-specific allow-list; the driver's `defaultEnv` then merges the
    // result on top of the PATH/HOME/XDG_* passthrough. Empty-string values
    // delete a key (standard env-merge semantics).
    const mergedEnv = mergeCallerEnv(vendorOpts.env, opts.env);
    const driverOpts: CursorDriverOptions = {
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
      const authOpts: CursorAuthOptions = {
        ...(vendorOpts.apiKey !== undefined ? { apiKey: vendorOpts.apiKey } : {}),
        ...(vendorOpts.authToken !== undefined ? { authToken: vendorOpts.authToken } : {}),
      };
      await applyCursorAuth(driver.client, authOpts);

      let vendorSessionId: SessionId;
      if (sessionId) {
        await driver.client.loadSession({ sessionId, cwd: opts.cwd });
        vendorSessionId = sessionId;
      } else {
        const result = await driver.client.newSession({ cwd: opts.cwd });
        if (!result.sessionId) {
          throw new Error("CursorAdapter: session/new returned no sessionId");
        }
        vendorSessionId = result.sessionId as SessionId;
      }

      const handle = new CursorHandle({
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
          `CursorAdapter: handle.runId=${handle.runId} does not match opts.runId=${opts.runId} (G8)`,
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
export function createCursorAdapter(options: CursorAdapterOptions = {}): CursorAdapter {
  return new CursorAdapter(options);
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
 * Cursor model catalog. Sourced from Cursor Desktop's `agent acp` release
 * notes; the default tracks the user's active Cursor model. Cursor does
 * not expose a programmatic list today — operators can always override
 * via `--model` / `shamu.config.ts`.
 */
export function listModels(): readonly ModelInfo[] {
  return [
    { id: "auto", label: "Cursor (auto)", default: true },
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5 (Cursor)" },
    { id: "gpt-5", label: "GPT-5 (Cursor)" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (Cursor)" },
  ];
}

/**
 * Merge `SpawnOpts.env` on top of `vendorOpts.env` with empty-string = delete
 * semantics. Returns `undefined` when neither side contributes a key (so the
 * caller can omit the field rather than pass an empty map). The driver's
 * own `defaultEnv` then layers the result on top of the PATH/HOME/XDG_*
 * passthrough.
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
