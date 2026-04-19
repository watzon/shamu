/**
 * `@shamu/adapter-amp` — production `AgentAdapter` for Amp.
 *
 * The stream-JSON-shell variation of the Claude/Codex family for Phase 7.D.
 * Spawns `amp -x --stream-json --stream-json-input` (or `amp threads continue
 * <id> -x …` on resume), keeps stdin open between turns, and projects amp's
 * JSONL output into Shamu's `AgentEvent` union.
 *
 * ### Lifecycle
 *
 *   new AmpAdapter()
 *     → .spawn(opts) / .resume(sid, opts)
 *       → applyAmpAuth(opts.vendorOpts.apiKey)    — resolve auth precedence
 *       → driverFactory(driverOpts)               — spawns the subprocess
 *       → new AmpHandle({ driver, ... })
 *         → consumeStdout() / consumeStderr()     — drain into event queue
 *
 *   handle.send({ text })
 *     → driver.writeLine('{"type":"user",...}\n')
 *
 *   handle.shutdown(reason)
 *     → emit session_end
 *     → driver.close()                            — stdin close → amp drain → SIGTERM fallback
 *     → await stdout/stderr drainers
 *     → close event queue
 *
 * ### Auth (see `auth.ts`)
 *
 * Precedence: `vendorOpts.apiKey` → `AMP_API_KEY` env (on the shamu process)
 * → skip (rely on `amp login`'s keychain token). Never persisted.
 *
 * ### Vendor path resolution (see `driver.ts`)
 *
 * `opts.vendorCliPath` → `AMP_CLI_PATH` env → `Bun.which("amp")` / PATH scan.
 * Missing binary surfaces `SpawnError` with the install hint.
 *
 * ### Resume
 *
 * `resume(sessionId, opts)` spawns a NEW subprocess with
 * `["threads", "continue", sessionId, "-x", "--stream-json",
 * "--stream-json-input"]`. Same downstream handle; the driver simply points
 * at a different argv.
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
import { type AmpAuthOptions, applyAmpAuth } from "./auth.ts";
import { type AmpDriver, type AmpDriverOptions, createRealAmpDriver } from "./driver.ts";
import { AmpHandle } from "./handle.ts";

export type { AmpAuthOptions, ResolvedAmpAuth } from "./auth.ts";
export { AmpAuthError, applyAmpAuth } from "./auth.ts";
export {
  type AmpDriver,
  type AmpDriverOptions,
  buildAmpArgv,
  createRealAmpDriver,
  resolveAmpBinaryPath,
  type SpawnFactoryOptions,
} from "./driver.ts";
export { AmpHandle, type AmpHandleOptions, formatUserTurn } from "./handle.ts";
export {
  decideAmpPermission,
  type PermissionDecision,
  type PermissionHandlerOptions,
  type ToolDispatchInput,
} from "./permission-handler.ts";
export {
  createProjectionState,
  type ProjectionContext,
  type ProjectionHooks,
  type ProjectionState,
  projectAmpLine,
  projectAmpMessage,
} from "./projection.ts";

const DEFAULT_VENDOR = "amp";

function loadAmpCapabilities(): Readonly<Capabilities> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "capabilities.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return freezeCapabilities(raw);
}

/**
 * Frozen capability manifest. Loaded once at module load; every handle
 * shares this reference. Capabilities are immutable at runtime (G8).
 */
export const AMP_CAPABILITIES: Readonly<Capabilities> = loadAmpCapabilities();

/** Per-spawn vendor options recognized by the Amp adapter. */
export interface AmpVendorOpts {
  /** Direct API key (preferred over env). Forwarded to `applyAmpAuth`. */
  readonly apiKey?: string;
  /** Extra args appended after the stream-json flags. Debug / test only. */
  readonly extraArgs?: readonly string[];
  /** Per-turn watchdog timeout on `writeLine → {type:"result"}`. Default 10m. */
  readonly promptTimeoutMs?: number;
  /**
   * Allow-listed env passed to the subprocess. Merged with the adapter's
   * defaults (PATH/HOME/LANG/USER/XDG_*). `AMP_API_KEY` is set from
   * `apiKey` resolution (via `applyAmpAuth`) regardless of this field.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** SIGKILL fallback delay on `driver.close()`. Default 2000 ms. */
  readonly sigkillTimeoutMs?: number;
}

export interface AmpAdapterOptions {
  /** Factory for the `AmpDriver`. Tests pass a scripted double. */
  readonly driverFactory?: (opts: AmpDriverOptions) => Promise<AmpDriver>;
  readonly clock?: MonotonicClock;
  readonly newEventId?: () => EventId;
  readonly newTurnId?: () => TurnId;
  readonly newToolCallId?: () => ToolCallId;
  readonly redactor?: Redactor;
  readonly vendor?: string;
}

export class AmpAdapter implements AgentAdapter {
  public readonly vendor: string;
  public readonly capabilities: Readonly<Capabilities> = AMP_CAPABILITIES;

  private readonly driverFactory: (opts: AmpDriverOptions) => Promise<AmpDriver>;
  private readonly clock: MonotonicClock | undefined;
  private readonly newEventIdFactory: (() => EventId) | undefined;
  private readonly newTurnIdFactory: (() => TurnId) | undefined;
  private readonly newToolCallIdFactory: (() => ToolCallId) | undefined;
  private readonly redactor: Redactor | undefined;

  constructor(options: AmpAdapterOptions = {}) {
    this.vendor = options.vendor ?? DEFAULT_VENDOR;
    this.driverFactory = options.driverFactory ?? createRealAmpDriver;
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
    const vendorOpts = (opts.vendorOpts ?? {}) as AmpVendorOpts;
    const authOpts: AmpAuthOptions = {
      ...(vendorOpts.apiKey !== undefined ? { apiKey: vendorOpts.apiKey } : {}),
    };
    const auth = applyAmpAuth(authOpts);

    const driverOpts: AmpDriverOptions = {
      cwd: opts.cwd,
      ...(opts.vendorCliPath !== undefined ? { vendorCliPath: opts.vendorCliPath } : {}),
      ...(vendorOpts.env !== undefined ? { env: vendorOpts.env } : {}),
      ...(vendorOpts.extraArgs !== undefined ? { extraArgs: vendorOpts.extraArgs } : {}),
      ...(vendorOpts.sigkillTimeoutMs !== undefined
        ? { sigkillTimeoutMs: vendorOpts.sigkillTimeoutMs }
        : {}),
      ...(auth.apiKey !== null ? { apiKey: auth.apiKey } : {}),
      ...(sessionId !== null ? { resumeThreadId: sessionId } : {}),
    };

    const driver = await this.driverFactory(driverOpts);
    try {
      const handle = new AmpHandle({
        driver,
        opts,
        vendor: this.vendor,
        capabilities: this.capabilities,
        vendorSessionId: sessionId,
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
          `AmpAdapter: handle.runId=${handle.runId} does not match opts.runId=${opts.runId} (G8)`,
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
export function createAmpAdapter(options: AmpAdapterOptions = {}): AmpAdapter {
  return new AmpAdapter(options);
}
