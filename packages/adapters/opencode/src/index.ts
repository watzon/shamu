/**
 * `@shamu/adapter-opencode` — production `AgentAdapter` for OpenCode.
 *
 * The SSE-HTTP reference adapter for Phase 7. OpenCode is transport-only —
 * the server delegates LLM calls to a user-configured provider (Anthropic,
 * OpenAI, Google, ...). Shamu treats it as an adapter like any other: the
 * capability manifest declares `costReporting: "subscription"` because the
 * real cost is billed by the downstream provider, not OpenCode itself.
 *
 * ### Lifecycle
 *
 *   new OpencodeAdapter()
 *     → .spawn(opts) / .resume(sid, opts)
 *       → driverFactory(opts)                 — server-spawn OR attach
 *       → client.session.create(...)          — if spawning
 *         OR client.session.get({ id })       — if resuming
 *       → new OpencodeHandle({ driver, ... })
 *         → consumeEventStream()              — SSE stream drains into queue
 *
 *   handle.send({ text })
 *     → client.session.prompt({ id, body })
 *
 *   handle.shutdown(reason)
 *     → emit session_end
 *     → event-stream.return()                 — drop SSE connection
 *     → driver.close()                        — close owned server, if any
 *
 * ### Server ownership
 *
 * Two deployment modes:
 *
 * 1. **Owned server** (default): the adapter spawns one OpenCode server per
 *    spawn() via `createOpencode()`. `shutdown()` closes it. This is the
 *    CLI + single-run pattern.
 *
 * 2. **Attached client**: the operator has a long-running OpenCode server
 *    (e.g., their desktop TUI) and sets `opts.vendorOpts.attachBaseUrl` to
 *    its URL. The adapter talks to that server instead of spawning; on
 *    shutdown it only releases the client. The operator owns the server
 *    lifecycle.
 *
 * ### Auth
 *
 * `opts.vendorOpts.auth` (via `ApplyOpencodeAuthOptions` / array) can
 * register one or more provider keys at spawn time. Skipping the field
 * leaves the server with whatever keys it was already configured with
 * (the OpenCode CLI persists keys to disk).
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
import { type ApplyOpencodeAuthOptions, applyOpencodeAuth } from "./auth.ts";
import {
  createRealOpencodeDriver,
  type OpencodeDriver,
  type OpencodeDriverOptions,
  type OpencodeSdkClient,
} from "./driver.ts";
import { OpencodeHandle } from "./handle.ts";

export type { ApplyOpencodeAuthOptions, ResolveAndApplyOptions } from "./auth.ts";
export { applyOpencodeAuth, OpencodeAuthError, resolveAndApplyOpencodeAuth } from "./auth.ts";
export {
  createRealOpencodeDriver,
  type OpencodeDriver,
  type OpencodeDriverOptions,
  type OpencodeSdkClient,
} from "./driver.ts";
export type { OpencodeHandleOptions } from "./handle.ts";
export { OpencodeHandle } from "./handle.ts";
export {
  decideOpencodePermission,
  type PermissionDecision,
  type PermissionHandlerOptions,
} from "./permission-handler.ts";
export {
  createProjectionState,
  type ProjectionContext,
  type ProjectionHooks,
  type ProjectionState,
  projectOpencodeEvent,
} from "./projection.ts";

const DEFAULT_VENDOR = "opencode";

function loadOpencodeCapabilities(): Readonly<Capabilities> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "capabilities.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return freezeCapabilities(raw);
}

/**
 * Frozen capability manifest. Loaded once at module load; every handle
 * shares this reference. Capabilities are immutable at runtime (G8).
 */
export const OPENCODE_CAPABILITIES: Readonly<Capabilities> = loadOpencodeCapabilities();

/**
 * Per-spawn vendor options recognized by the OpenCode adapter. Declared as
 * a standalone interface for readability; consumers supply this through
 * `SpawnOpts.vendorOpts`.
 */
export interface OpencodeVendorOpts {
  /**
   * Attach to an existing OpenCode server instead of spawning one. When
   * set, `shutdown()` only releases the client reference.
   */
  readonly attachBaseUrl?: string;
  /** Owned-server host; default `127.0.0.1` (SDK default). */
  readonly hostname?: string;
  /** Owned-server port; default OS-assigned. */
  readonly port?: number;
  /** Spawn timeout in ms passed to `createOpencode`. */
  readonly spawnTimeoutMs?: number;
  /**
   * One or more provider-auth registrations applied before the first
   * `session.prompt`. Omit to leave the server's existing auth alone.
   */
  readonly auth?: readonly ApplyOpencodeAuthOptions[];
  /**
   * Override the `session.prompt` watchdog timeout (OpenCode#6573). Default
   * 10 minutes. Use a shorter value in test suites / CI.
   */
  readonly promptTimeoutMs?: number;
  /** Override the initial session title. */
  readonly sessionTitle?: string;
}

export interface OpencodeAdapterOptions {
  /**
   * Factory for the `OpencodeDriver`. Tests pass a scripted double;
   * production defaults to `createRealOpencodeDriver`.
   */
  readonly driverFactory?: (opts: OpencodeDriverOptions) => Promise<OpencodeDriver>;
  readonly clock?: MonotonicClock;
  readonly newEventId?: () => EventId;
  readonly newTurnId?: () => TurnId;
  readonly newToolCallId?: () => ToolCallId;
  readonly redactor?: Redactor;
  readonly vendor?: string;
}

export class OpencodeAdapter implements AgentAdapter {
  public readonly vendor: string;
  public readonly capabilities: Readonly<Capabilities> = OPENCODE_CAPABILITIES;

  private readonly driverFactory: (opts: OpencodeDriverOptions) => Promise<OpencodeDriver>;
  private readonly clock: MonotonicClock | undefined;
  private readonly newEventIdFactory: (() => EventId) | undefined;
  private readonly newTurnIdFactory: (() => TurnId) | undefined;
  private readonly newToolCallIdFactory: (() => ToolCallId) | undefined;
  private readonly redactor: Redactor | undefined;

  constructor(options: OpencodeAdapterOptions = {}) {
    this.vendor = options.vendor ?? DEFAULT_VENDOR;
    this.driverFactory = options.driverFactory ?? createRealOpencodeDriver;
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
    const vendorOpts = (opts.vendorOpts ?? {}) as OpencodeVendorOpts;
    const driverOpts: OpencodeDriverOptions = {
      ...(vendorOpts.attachBaseUrl !== undefined
        ? { attachBaseUrl: vendorOpts.attachBaseUrl }
        : {}),
      ...(vendorOpts.hostname !== undefined ? { hostname: vendorOpts.hostname } : {}),
      ...(vendorOpts.port !== undefined ? { port: vendorOpts.port } : {}),
      ...(vendorOpts.spawnTimeoutMs !== undefined
        ? { spawnTimeoutMs: vendorOpts.spawnTimeoutMs }
        : {}),
    };
    const driver = await this.driverFactory(driverOpts);
    try {
      if (vendorOpts.auth) {
        for (const entry of vendorOpts.auth) {
          await applyOpencodeAuth(driver.client, entry);
        }
      }
      const vendorSessionId = sessionId
        ? await ensureSessionExists(driver.client, sessionId)
        : await createSession(driver.client, vendorOpts.sessionTitle);

      const handle = new OpencodeHandle({
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
          `OpencodeAdapter: handle.runId=${handle.runId} does not match opts.runId=${opts.runId} (G8)`,
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
export function createOpencodeAdapter(options: OpencodeAdapterOptions = {}): OpencodeAdapter {
  return new OpencodeAdapter(options);
}

/**
 * Create a fresh OpenCode session on the server. Returns the vendor session
 * id (typed as a shamu `SessionId` brand for downstream consumers).
 */
async function createSession(
  client: OpencodeSdkClient,
  title: string | undefined,
): Promise<SessionId> {
  const res = await client.session.create({
    body: title ? { title } : {},
  });
  const id = res.data?.id;
  if (!id) {
    throw new Error("OpencodeAdapter: server session.create returned no id");
  }
  return id as SessionId;
}

/**
 * Verify the given `sessionId` exists server-side before attaching. A 404
 * surfaces as a thrown error the caller can show the operator ("the
 * resumed session has been garbage-collected; start a fresh run").
 */
async function ensureSessionExists(
  client: OpencodeSdkClient,
  sessionId: SessionId,
): Promise<SessionId> {
  const res = await client.session.get({ path: { id: sessionId } });
  const id = res.data?.id;
  if (!id) {
    throw new Error(`OpencodeAdapter: session ${sessionId} not found on server (expired?)`);
  }
  return id as SessionId;
}
