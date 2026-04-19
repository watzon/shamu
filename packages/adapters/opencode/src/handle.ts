/**
 * `OpencodeHandle` — the live `AgentHandle` for an OpenCode run.
 *
 * Responsibilities:
 *
 * 1. Subscribe to `client.event.subscribe()` once at construction and drain
 *    the SSE stream into the event queue. The subscription is shared across
 *    turns — one subscription per handle, not per send().
 * 2. On each `send()`, POST `client.session.prompt({ ... })` and forget it
 *    (fire-and-async-await). The SSE stream supplies the per-event data; the
 *    `prompt` response is the final AssistantMessage which we consume for
 *    its token/cost numbers.
 * 3. Apply `decideOpencodePermission` to pending tool calls BEFORE they
 *    dispatch (G4/G5). On denial, emit a typed `error` + call
 *    `session.abort()` to stop the server from running the tool.
 * 4. Run the redactor on every emitted event (G1).
 * 5. On `shutdown()`, close the SSE stream, call `driver.close()` (which
 *    reaps the owned server if we spawned one), and close the event queue.
 *
 * Concurrency: one in-flight turn per handle, mirroring Claude/Codex.
 * `send()` while a turn is active throws — the supervisor is responsible
 * for serializing.
 *
 * ### session.prompt timeout (OpenCode #6573 watchdog)
 *
 * A hung tool can wedge the SSE stream. Each `send()` arms a watchdog: if
 * `promptTimeoutMs` elapses without a terminal event (session.idle /
 * session.error), the handle aborts the session and emits a synthetic
 * turn_end with `stopReason: "prompt_watchdog"`. Default is generous
 * (10 minutes) so legitimate long-running tasks aren't killed.
 */

import type { Event as OpencodeEvent } from "@opencode-ai/sdk";
import {
  type AgentEvent,
  type AgentHandle,
  type Capabilities,
  CorrelationState,
  type HandleHeartbeat,
  type MonotonicClock,
  type PermissionMode,
  type SpawnOpts,
  type UserTurn,
  validateEvent,
} from "@shamu/adapters-base";
import type { EventId, RunId, SessionId, ToolCallId, TurnId } from "@shamu/shared/ids";
import { Redactor } from "@shamu/shared/redactor";
import type { OpencodeDriver } from "./driver.ts";
import { decideOpencodePermission, type PermissionHandlerOptions } from "./permission-handler.ts";
import {
  createProjectionState,
  type ProjectionContext,
  type ProjectionHooks,
  type ProjectionState,
  projectOpencodeEvent,
} from "./projection.ts";

const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Await `promise` but give up after `ms`. Always resolves (never rejects);
 * on timeout, the returned promise resolves while the underlying promise
 * continues to run (and its outcome is ignored). Used inside `shutdown()`
 * so an SDK-level hang can't block the orchestrator from reaping state.
 */
function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    promise.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

class OpencodeEventQueue {
  private readonly waiters: Array<(v: IteratorResult<AgentEvent>) => void> = [];
  private readonly pending: AgentEvent[] = [];
  private closed = false;

  push(ev: AgentEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: ev, done: false });
      return;
    }
    this.pending.push(ev);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) w({ value: undefined, done: true });
    }
  }

  async *iterate(): AsyncIterableIterator<AgentEvent> {
    while (true) {
      const buffered = this.pending.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

export interface OpencodeHandleOptions {
  readonly driver: OpencodeDriver;
  readonly opts: SpawnOpts;
  readonly vendor: string;
  readonly capabilities: Capabilities;
  readonly vendorSessionId: SessionId;
  readonly sessionSource: "spawn" | "resume" | "fork";
  readonly clock?: MonotonicClock | undefined;
  readonly newEventId?: (() => EventId) | undefined;
  readonly newTurnId?: (() => TurnId) | undefined;
  readonly newToolCallId?: (() => ToolCallId) | undefined;
  readonly redactor?: Redactor | undefined;
  readonly promptTimeoutMs?: number | undefined;
  /**
   * Upper bound (ms) on each stage of `shutdown()`'s transport reap.
   * Default 5s. Set higher in environments where the server's own
   * close path is slow.
   */
  readonly shutdownTimeoutMs?: number | undefined;
  /**
   * Provider id used by `session.prompt`. Required in production unless
   * the attached server has a configured default. Omitted → prompt is
   * sent without provider selection and the server chooses (or fails).
   */
  readonly providerID?: string | undefined;
  /** Model id for the selected provider. Must pair with `providerID`. */
  readonly modelID?: string | undefined;
  /** Override the permission handler (tests). */
  readonly permissionOptionsOverride?: PermissionHandlerOptions | undefined;
}

/**
 * The live handle. Exported so a custom adapter class can subclass it if
 * needed; production code goes through `createOpencodeAdapter(...)`.
 */
export class OpencodeHandle implements AgentHandle {
  public readonly runId: RunId;
  private _sessionId: SessionId;
  private readonly driver: OpencodeDriver;
  private readonly corr: CorrelationState;
  private readonly queue = new OpencodeEventQueue();
  private readonly redactor: Redactor;
  private readonly capabilities: Capabilities;
  private readonly permissionOpts: PermissionHandlerOptions;
  private readonly projState: ProjectionState;
  private readonly projHooks: ProjectionHooks;
  private readonly sessionSource: "spawn" | "resume" | "fork";
  private readonly promptTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly providerID: string | undefined;
  private readonly modelID: string | undefined;

  private currentModel: string;
  private lastEventAt = 0;
  private eventStreamReturn: (() => Promise<void>) | null = null;
  private turnActive = false;
  private closed = false;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: OpencodeHandleOptions) {
    // G8 — runId is orchestrator-owned.
    if (!options.opts.runId) {
      throw new Error("OpencodeHandle: opts.runId is required (G8)");
    }
    this.runId = options.opts.runId;
    this._sessionId = options.vendorSessionId;
    this.driver = options.driver;
    this.capabilities = options.capabilities;
    this.redactor = options.redactor ?? new Redactor();
    this.currentModel = options.opts.model ?? "opencode-default";
    this.sessionSource = options.sessionSource;
    this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.providerID = options.providerID;
    this.modelID = options.modelID;

    this.corr = new CorrelationState({
      runId: this.runId,
      sessionId: this._sessionId,
      vendor: options.vendor,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.newEventId ? { newEventId: options.newEventId } : {}),
      ...(options.newTurnId ? { newTurnId: options.newTurnId } : {}),
    });

    this.projState = createProjectionState();
    this.projHooks = {
      modelProvider: () => this.currentModel,
      ...(options.newToolCallId ? { newToolCallId: options.newToolCallId } : {}),
      onSessionBound: (sid) => {
        this._sessionId = sid;
      },
    };

    this.permissionOpts = options.permissionOptionsOverride ?? {
      worktreeRoot: options.opts.cwd,
    };

    // Start the SSE subscription immediately. Fire-and-forget; the drain
    // completes either on stream close (normal shutdown) or on an SDK
    // error that we surface as an `error` event. We don't retain the
    // promise — `shutdown()` drives shutdown via `eventStreamReturn()`.
    void this.consumeEventStream().catch((err) => {
      if (this.closed) return;
      this.emitSafely({
        ...this.safeEnvelope(),
        kind: "error",
        fatal: true,
        errorCode: "opencode_event_stream_failure",
        message: this.redactor.redact((err as Error)?.message ?? String(err)),
        retriable: false,
      });
    });
  }

  get sessionId(): SessionId | null {
    return this._sessionId;
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.queue.iterate();
  }

  heartbeat(): HandleHeartbeat {
    return { lastEventAt: this.lastEventAt, seq: this.corr.peekSeq() };
  }

  async send(message: UserTurn): Promise<void> {
    if (this.closed) throw new Error("OpencodeHandle: send() after shutdown()");
    if (this.turnActive) {
      throw new Error("OpencodeHandle: send() while a turn is already active");
    }
    this.turnActive = true;
    this.armWatchdog();

    const redactedText = this.redactor.redact(message.text);
    try {
      await this.driver.client.session.prompt({
        path: { id: this._sessionId },
        body: {
          // SDK expects a mutable array here; we build a fresh one per call.
          parts: [{ type: "text" as const, text: redactedText }],
          ...(this.providerID !== undefined ? { providerID: this.providerID } : {}),
          ...(this.modelID !== undefined ? { modelID: this.modelID } : {}),
        },
      });
    } catch (cause) {
      if (!this.closed) {
        this.emitSafely({
          ...this.safeEnvelope(),
          kind: "error",
          fatal: true,
          errorCode: "opencode_prompt_failed",
          message: this.redactor.redact((cause as Error)?.message ?? String(cause)),
          retriable: false,
        });
        // Force a turn_end so consumers' for-await doesn't hang.
        this.forceTurnEnd("prompt_error");
      }
    } finally {
      // `turnActive` is cleared when `session.idle` lands on the SSE stream,
      // or when the watchdog synthesizes a turn_end. `session.prompt` itself
      // resolves when the assistant message is fully built, which is earlier
      // than idle — leave `turnActive` alone here.
    }
  }

  async interrupt(reason?: string): Promise<void> {
    if (this.closed) return;
    // Emit the interrupt inside whatever turn is currently open; if none,
    // open a micro-turn for the event.
    try {
      this.emit({
        ...this.corr.envelope(),
        kind: "interrupt",
        requestedBy: "user",
        delivered: this.turnActive,
      });
    } catch {
      this.corr.startTurn();
      this.projState.turnOpen = true;
      this.emit({
        ...this.corr.envelope(),
        kind: "interrupt",
        requestedBy: "user",
        delivered: false,
      });
    }
    try {
      await this.driver.client.session.abort({ path: { id: this._sessionId } });
    } catch {
      // Abort is best-effort. If the session is already idle the server
      // returns 400; swallow.
    }
    // Force a turn_end so the iterator advances even if the server doesn't
    // emit `session.idle` promptly.
    this.forceTurnEnd(reason ?? "interrupted");
  }

  async setModel(model: string): Promise<void> {
    if (typeof model !== "string" || model.length === 0) {
      throw new Error("OpencodeHandle.setModel: model must be a non-empty string");
    }
    // OpenCode binds model at prompt time (per-call `body.model`). The
    // cheapest way to honor this is to stash the new model and apply it
    // on the next `send()`. Today the handle doesn't thread a per-call
    // model into `session.prompt` — we stash it for the `usage` event
    // stamping. A future revision can wire `body.model` through; see
    // the README.
    this.currentModel = model;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.capabilities.permissionModes.includes(mode)) {
      throw new Error(`OpencodeHandle.setPermissionMode: ${mode} not declared in capabilities`);
    }
    // Permission mode on OpenCode is a server-level config. Mid-run mode
    // changes aren't supported by the current server; record the request
    // as a no-op. Supervisors that need a mode change should resume on a
    // fresh handle with the new mode.
  }

  async shutdown(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Stop the watchdog before anything else so a pending fire can't
    // race with shutdown.
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    // Best-effort session_end inside a valid envelope. Open a micro-turn
    // if necessary.
    try {
      if (!this.projState.turnOpen) {
        this.corr.startTurn();
        this.projState.turnOpen = true;
      }
      this.emit({
        ...this.corr.envelope(),
        kind: "session_end",
        reason,
      });
      this.corr.endTurn();
      this.projState.turnOpen = false;
    } catch {
      // Envelope state wedged — queue-close is the contract.
    }
    // Reap the spawned server subprocess FIRST — closing the underlying
    // transport unblocks the SSE generator, which would otherwise sit
    // forever on an unresolved promise. In attached-mode this still works:
    // `driver.close()` is a no-op and `eventStreamReturn()` delivers the
    // cancellation to the generator.
    //
    // Both calls below are wrapped in a bounded timeout because we've
    // observed `createOpencode()`'s SDK-returned `close()` and/or the SSE
    // generator's `return()` hang indefinitely against the real server
    // (e.g. when the subprocess is still draining its last message). An
    // orchestrator losing control of its shutdown path is worse than a
    // potentially-orphaned server subprocess — the operating system reaps
    // the child on process exit, and the tests assert no zombies for the
    // normal path. Default 5s each; configurable via `shutdownTimeoutMs`.
    const shutdownTimeoutMs = this.shutdownTimeoutMs;
    await withTimeout(
      (async () => {
        try {
          await this.driver.close();
        } catch {
          // best-effort
        }
      })(),
      shutdownTimeoutMs,
    );
    if (this.eventStreamReturn) {
      await withTimeout(
        (async () => {
          try {
            await this.eventStreamReturn?.();
          } catch {
            // best-effort
          }
        })(),
        shutdownTimeoutMs,
      );
    }
    this.queue.close();
  }

  // --- internals ----------------------------------------------------------

  private async consumeEventStream(): Promise<void> {
    const res = await this.driver.client.event.subscribe();
    const iter = res.stream;
    // Capture the generator's `return` so shutdown can unblock the for-await.
    const inner = iter as AsyncGenerator<unknown, void, unknown>;
    this.eventStreamReturn = async () => {
      try {
        await inner.return?.();
      } catch {
        // ignore
      }
    };
    try {
      for await (const raw of inner) {
        if (this.closed) break;
        this.handleIncomingEvent(raw as OpencodeEvent);
      }
    } catch (err) {
      if (!this.closed) throw err;
    }
  }

  private handleIncomingEvent(ev: OpencodeEvent): void {
    // G4/G5 gate: pending tool calls get checked BEFORE we project them,
    // so a denial emits error + abort rather than letting the tool run.
    if (
      ev.type === "message.part.updated" &&
      ev.properties.part.type === "tool" &&
      ev.properties.part.sessionID === this._sessionId
    ) {
      const tp = ev.properties.part;
      const statusObj = tp.state as { status: string; input?: Record<string, unknown> };
      if (statusObj.status === "pending" || statusObj.status === "running") {
        const decision = decideOpencodePermission(
          { tool: tp.tool, ...(statusObj.input ? { input: statusObj.input } : {}) },
          this.permissionOpts,
        );
        if (decision && decision.kind === "denied") {
          // Project the pending tool_call so the consumer sees it, then
          // emit the error + abort. We re-enter the projector with the
          // unchanged event so the normal path runs (same pattern as
          // Codex).
          const projected = this.runProjector(ev);
          for (const out of projected) this.emit(out);
          try {
            this.emit({
              ...this.corr.envelope(),
              kind: "error",
              fatal: true,
              errorCode: decision.error.code,
              message: this.redactor.redact(decision.error.message),
              retriable: false,
            });
          } catch {
            // envelope may be wedged; ignore
          }
          // Abort the session so the server stops. `turn_end` will land via
          // the regular stream once `session.idle` or `session.error`
          // arrives; forceTurnEnd makes sure it happens either way.
          void this.driver.client.session.abort({ path: { id: this._sessionId } }).catch(() => {});
          this.forceTurnEnd("path_scope_violation");
          return;
        }
      }
    }

    const projected = this.runProjector(ev);
    for (const out of projected) this.emit(out);

    // Turn-end trigger: our projector emits `turn_end` on `session.idle` or
    // `session.error`. When we see either, mark turnActive false + disarm
    // watchdog.
    if (ev.type === "session.idle" || ev.type === "session.error") {
      this.turnActive = false;
      if (this.watchdogTimer) {
        clearTimeout(this.watchdogTimer);
        this.watchdogTimer = null;
      }
    }
  }

  private runProjector(ev: OpencodeEvent): AgentEvent[] {
    const ctx: ProjectionContext = {
      corr: this.corr,
      state: this.projState,
      sessionSource: this.sessionSource,
      targetSessionId: this._sessionId,
      hooks: this.projHooks,
    };
    return projectOpencodeEvent(ev, ctx);
  }

  private emit(raw: AgentEvent): void {
    // Redact, validate, enqueue.
    const redacted = this.redactEvent(raw);
    const validated = validateEvent(redacted);
    this.lastEventAt = validated.tsWall;
    this.queue.push(validated);
  }

  private emitSafely(raw: AgentEvent): void {
    try {
      this.emit(raw);
    } catch {
      // Validation or envelope wedged; swallow so shutdown completes.
    }
  }

  /**
   * Produce a well-formed envelope even if no turn is currently open.
   * Opens a micro-turn as needed. Used by error paths where the regular
   * `this.corr.envelope()` would throw.
   */
  private safeEnvelope() {
    if (!this.projState.turnOpen) {
      this.corr.startTurn();
      this.projState.turnOpen = true;
    }
    return this.corr.envelope();
  }

  private forceTurnEnd(stopReason: string): void {
    if (!this.projState.turnOpen) return;
    try {
      this.emit({
        ...this.corr.envelope(),
        kind: "usage",
        model: this.currentModel,
        tokens: { input: 0, output: 0 },
        cache: { hits: 0, misses: 0 },
      });
      this.emit({
        ...this.corr.envelope(),
        kind: "cost",
        usd: null,
        confidence: "unknown",
        source: "subscription",
      });
      this.emit({
        ...this.corr.envelope(),
        kind: "turn_end",
        stopReason,
        durationMs: 0,
      });
      this.corr.endTurn();
    } catch {
      // Envelope wedged.
    }
    this.projState.turnOpen = false;
    this.projState.assistantFinish = null;
    this.turnActive = false;
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private armWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (this.closed || !this.turnActive) return;
      // Abort the server + force turn_end. OpenCode#6573 scenario.
      void this.driver.client.session.abort({ path: { id: this._sessionId } }).catch(() => {});
      this.forceTurnEnd("prompt_watchdog");
    }, this.promptTimeoutMs);
  }

  private redactEvent(ev: AgentEvent): AgentEvent {
    const r = (s: string): string => this.redactor.redact(s);
    switch (ev.kind) {
      case "reasoning":
        return { ...ev, text: r(ev.text) };
      case "assistant_delta":
        return { ...ev, text: r(ev.text) };
      case "assistant_message":
        return { ...ev, text: r(ev.text), stopReason: r(ev.stopReason) };
      case "tool_call":
        return { ...ev, args: this.redactArgs(ev.args) };
      case "tool_result":
        return { ...ev, summary: r(ev.summary) };
      case "patch_applied":
        return ev;
      case "checkpoint":
        return { ...ev, summary: r(ev.summary) };
      case "stdout":
      case "stderr":
        return { ...ev, text: r(ev.text) };
      case "session_end":
        return { ...ev, reason: r(ev.reason) };
      case "turn_end":
        return { ...ev, stopReason: r(ev.stopReason) };
      case "usage":
        return { ...ev, model: r(ev.model) };
      case "cost":
        return { ...ev, source: r(ev.source) };
      case "error":
        return { ...ev, message: r(ev.message), errorCode: r(ev.errorCode) };
      case "session_start":
      case "permission_request":
      case "rate_limit":
      case "interrupt":
        return ev;
    }
  }

  private redactArgs(args: unknown): unknown {
    if (args === null || args === undefined) return args;
    if (typeof args === "string") return this.redactor.redact(args);
    if (Array.isArray(args)) return args.map((v) => this.redactArgs(v));
    if (typeof args === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
        out[k] = this.redactArgs(v);
      }
      return out;
    }
    return args;
  }
}
