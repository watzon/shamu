/**
 * `@shamu/adapter-pi` — production `AgentAdapter` for Pi.
 *
 * The JSONL-over-stdio variation adapter for Phase 7.E. Pi uses its own
 * command/response/event dictionary over strict LF-only JSONL (not
 * JSON-RPC 2.0). See `docs/phase-7/adapter-transports.md` for the
 * classification rationale.
 *
 * ### Lifecycle
 *
 *   new PiAdapter()
 *     → .spawn(opts) / .resume(sid, opts)
 *       → driverFactory(driverOpts)            — spawns pi --mode rpc
 *       → (optional) `{type:"ready"}` handshake drained by driver
 *       → client.sendCommand("new_session", ...) on spawn
 *          OR sendCommand("switch_session", { sessionPath }) on resume
 *       → new PiHandle({ ... })
 *
 *   handle.send({ text })
 *     → client.sendCommand("prompt", { message: text })
 *     → turn_start / message_* / tool_execution_* / turn_end on async stream
 *
 *   handle.shutdown(reason)
 *     → emit session_end
 *     → driver.close()                          — ends stdin, reaps Pi
 *     → close event queue
 *
 * ### Vendor path resolution (see `driver.ts`)
 *
 * `opts.vendorCliPath` → `PI_CLI_PATH` env → `Bun.which("pi")`.
 * Missing binary surfaces `SpawnError` with the "install via npm -g
 * @mariozechner/pi-coding-agent" hint.
 *
 * ### Auth
 *
 * See `auth.ts`. V1: adapter does NOT manage Pi auth. The operator runs
 * `pi login <provider>` once, or sets `ANTHROPIC_API_KEY` /
 * `OPENAI_API_KEY` / etc. in the environment — `driver.defaultEnv` forwards
 * them into the subprocess.
 *
 * ### Resume semantics
 *
 * Pi persists session state to a JSONL file on disk (`~/.config/...`) by
 * default; `--no-session` opts out. The `switch_session` RPC command takes
 * a **sessionPath** (absolute path to a session JSONL) rather than an
 * opaque sessionId. We treat the shamu `SessionId` as that opaque
 * sessionPath; callers that resumed a Pi session know they need to hand
 * us the path.
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
import type { EventId, SessionId, ToolCallId, TurnId } from "@shamu/shared/ids";
import type { Redactor } from "@shamu/shared/redactor";
import { createRealPiDriver, type PiDriver, type PiDriverOptions } from "./driver.ts";
import { PiHandle } from "./handle.ts";
import type { PiRpcClientOptions } from "./rpc-client.ts";

export {
  createRealPiDriver,
  type PiDriver,
  type PiDriverOptions,
  type PiSpawnImpl,
  type PiSpawnLike,
  resolvePiBinaryPath,
} from "./driver.ts";
export {
  PiAuthError,
  PiCommandError,
  PiProtocolError,
  PiShutdownError,
  PiTimeoutError,
} from "./errors.ts";
export {
  bytesToStrings,
  type DecodedLine,
  decodeFrames,
  encodeFrame,
} from "./framing.ts";
export type { PiHandleOptions } from "./handle.ts";
export { PiHandle } from "./handle.ts";
export {
  decidePiPermission,
  type PermissionDecision,
  type PermissionHandlerOptions,
} from "./permission-handler.ts";
export {
  createProjectionState,
  type ProjectionContext,
  type ProjectionHooks,
  type ProjectionState,
  projectPiEvent,
} from "./projection.ts";
export {
  createPiRpcClient,
  type PiAsyncEvent,
  type PiResponseFrame,
  type PiRpcClient,
  type PiRpcClientOptions,
  type PiRpcTransport,
} from "./rpc-client.ts";
export { piVendorCliDescriptor } from "./vendor-cli-descriptor.ts";

const DEFAULT_VENDOR = "pi";

function loadPiCapabilities(): Readonly<Capabilities> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "capabilities.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return freezeCapabilities(raw);
}

/**
 * Frozen capability manifest. Loaded once at module load; every handle
 * shares this reference. Capabilities are immutable at runtime (G8).
 */
export const PI_CAPABILITIES: Readonly<Capabilities> = loadPiCapabilities();

/** Per-spawn vendor options recognized by the Pi adapter. */
export interface PiVendorOpts {
  /**
   * When true, spawn Pi with `--no-session` so the conversation isn't
   * persisted to disk. Default: false (Pi's on-disk sessions are the
   * documented default).
   */
  readonly ephemeralSession?: boolean;
  /**
   * Extra args appended to `pi --mode rpc` at spawn. Test / debug only.
   */
  readonly extraArgs?: readonly string[];
  /** Per-turn prompt watchdog timeout. Default 10 minutes. */
  readonly promptTimeoutMs?: number;
  /**
   * Allow-listed env passed to the subprocess. Merged with the adapter's
   * defaults (PATH/HOME/XDG_* + common provider keys).
   */
  readonly env?: Readonly<Record<string, string>>;
  /** SIGKILL fallback delay for `driver.close()`. Default 2000 ms. */
  readonly sigkillTimeoutMs?: number;
  /** Pi RPC client options forwarded to `createPiRpcClient`. */
  readonly clientOptions?: PiRpcClientOptions;
  /** Override Pi's handshake grace window. Default 500 ms. */
  readonly handshakeGraceMs?: number;
  /** Override Pi's handshake hard-cap. Default 5000 ms. */
  readonly handshakeTimeoutMs?: number;
  /**
   * Optional session-name override applied post-spawn via
   * `set_session_name` RPC.
   */
  readonly sessionTitle?: string;
  /**
   * Provider name passed as `--provider <name>` on the `pi --mode rpc`
   * spawn. Pi's default is `google`; set this to one of your configured
   * providers (`anthropic`, `openai`, `fireworks-ai`, …) if google isn't
   * your choice. Pi resolves the API key from its own config + env.
   */
  readonly providerID?: string;
  /**
   * Model id / pattern passed as `--model <pattern>` on the spawn. Supports
   * Pi's documented pattern syntax (`"provider/id"`, optional `":thinking"`).
   * Omit to use the provider's default.
   */
  readonly modelID?: string;
}

export interface PiAdapterOptions {
  /** Factory for the `PiDriver`. Tests pass a scripted double. */
  readonly driverFactory?: (opts: PiDriverOptions) => Promise<PiDriver>;
  readonly clock?: MonotonicClock;
  readonly newEventId?: () => EventId;
  readonly newTurnId?: () => TurnId;
  readonly newToolCallId?: () => ToolCallId;
  readonly redactor?: Redactor;
  readonly vendor?: string;
}

/**
 * The Pi adapter. One instance per process; reused across runs.
 */
export class PiAdapter implements AgentAdapter {
  public readonly vendor: string;
  public readonly capabilities: Readonly<Capabilities> = PI_CAPABILITIES;

  private readonly driverFactory: (opts: PiDriverOptions) => Promise<PiDriver>;
  private readonly clock: MonotonicClock | undefined;
  private readonly newEventIdFactory: (() => EventId) | undefined;
  private readonly newTurnIdFactory: (() => TurnId) | undefined;
  private readonly newToolCallIdFactory: (() => ToolCallId) | undefined;
  private readonly redactor: Redactor | undefined;

  constructor(options: PiAdapterOptions = {}) {
    this.vendor = options.vendor ?? DEFAULT_VENDOR;
    this.driverFactory = options.driverFactory ?? createRealPiDriver;
    this.clock = options.clock;
    this.newEventIdFactory = options.newEventId;
    this.newTurnIdFactory = options.newTurnId;
    this.newToolCallIdFactory = options.newToolCallId;
    this.redactor = options.redactor;
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
    const vendorOpts = (opts.vendorOpts ?? {}) as PiVendorOpts;
    // Translate `providerID` / `modelID` into Pi's native spawn flags and
    // prepend them to whatever `extraArgs` the caller supplied. Pi's default
    // provider is `google`; without this surface the adapter is effectively
    // unusable against any other provider configured in the user's Pi install.
    const providerModelArgs: string[] = [];
    if (vendorOpts.providerID !== undefined) {
      providerModelArgs.push("--provider", vendorOpts.providerID);
    }
    if (vendorOpts.modelID !== undefined) {
      providerModelArgs.push("--model", vendorOpts.modelID);
    }
    const mergedExtraArgs: readonly string[] = [
      ...providerModelArgs,
      ...(vendorOpts.extraArgs ?? []),
    ];
    // `SpawnOpts.env` merges on top of `vendorOpts.env`. Broker-supplied
    // HTTPS_PROXY/HTTP_PROXY/NO_PROXY win over caller-supplied vendor env;
    // the driver's `defaultEnv` then layers the result on top of
    // PATH/HOME/XDG_* + provider-API keys. Empty-string values delete a key.
    const mergedEnv = mergeCallerEnv(vendorOpts.env, opts.env);
    const driverOpts: PiDriverOptions = {
      ...(opts.vendorCliPath !== undefined ? { vendorCliPath: opts.vendorCliPath } : {}),
      cwd: opts.cwd,
      ...(mergedEnv !== undefined ? { env: mergedEnv } : {}),
      ...(mergedExtraArgs.length > 0 ? { extraArgs: mergedExtraArgs } : {}),
      ...(vendorOpts.ephemeralSession !== undefined
        ? { ephemeralSession: vendorOpts.ephemeralSession }
        : {}),
      ...(vendorOpts.sigkillTimeoutMs !== undefined
        ? { sigkillTimeoutMs: vendorOpts.sigkillTimeoutMs }
        : {}),
      ...(vendorOpts.handshakeGraceMs !== undefined
        ? { handshakeGraceMs: vendorOpts.handshakeGraceMs }
        : {}),
      ...(vendorOpts.handshakeTimeoutMs !== undefined
        ? { handshakeTimeoutMs: vendorOpts.handshakeTimeoutMs }
        : {}),
      ...(vendorOpts.clientOptions !== undefined
        ? { clientOptions: vendorOpts.clientOptions }
        : {}),
    };

    const driver = await this.driverFactory(driverOpts);
    try {
      let vendorSessionId: SessionId;
      if (sessionId) {
        // Resume path: the shamu `SessionId` is the opaque Pi session file
        // path. `switch_session` loads the conversation back into memory.
        await driver.client.sendCommand("switch_session", { sessionPath: sessionId });
        vendorSessionId = sessionId;
      } else {
        // Spawn path: ask Pi to create a fresh session. Pi's rpc.md
        // documents `{type:"new_session"}` as the command; the returned
        // `data` typically carries the sessionId/sessionPath.
        const data = await driver.client.sendCommand<Record<string, unknown> | undefined>(
          "new_session",
          {},
        );
        const extracted = extractSessionId(data);
        // Some Pi builds return no data on new_session (fresh session is
        // implicit on startup); fall back to a placeholder that the
        // handle's `onSessionBound` projector hook will later update.
        vendorSessionId = (extracted ?? "pi-session-pending") as SessionId;
      }

      if (vendorOpts.sessionTitle) {
        try {
          await driver.client.sendCommand("set_session_name", { name: vendorOpts.sessionTitle });
        } catch {
          // non-fatal — Pi may reject an unsupported title format.
        }
      }

      const handle = new PiHandle({
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
          `PiAdapter: handle.runId=${handle.runId} does not match opts.runId=${opts.runId} (G8)`,
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
export function createPiAdapter(options: PiAdapterOptions = {}): PiAdapter {
  return new PiAdapter(options);
}

/**
 * Merge `SpawnOpts.env` on top of `vendorOpts.env` with empty-string = delete
 * semantics. Returns `undefined` when neither side contributes. The driver's
 * `defaultEnv` then layers the result on top of the PATH/HOME/XDG_* +
 * provider-API-key passthrough.
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

/**
 * Extract the session identifier from a `new_session` response's `data`
 * field. Pi's rpc.md documents `sessionId` and `sessionFile` — we accept
 * either so different Pi releases work.
 */
function extractSessionId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  const candidates = ["sessionId", "session_id", "sessionPath", "session_path", "sessionFile"];
  for (const k of candidates) {
    const v = data[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}
