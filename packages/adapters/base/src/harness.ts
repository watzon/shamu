/**
 * Shared adapter-handle harness (Phase 7 cleanup).
 *
 * The Cursor, Gemini, Amp, and Pi handles carry roughly 90% structurally
 * identical machinery: a single-consumer event queue, a per-turn 10-minute
 * watchdog, a redactor pass on every emitted event, a shutdown sequence that
 * closes the driver first (reaping the subprocess) and then drains the
 * in-flight async iterator before closing the queue, plus the boilerplate
 * around `runId` G8 enforcement, envelope threading, `forceTurnEnd`, and
 * `safeEnvelope`. This module extracts those primitives so each adapter
 * surfaces only the vendor-specific send/interrupt/setModel bits.
 *
 * ### Why OpenCode is excluded
 *
 * `@shamu/adapter-opencode` has a structurally different send path (the
 * SDK's `session.prompt` resolves after the full assistant message, not
 * after the prompt ack; the SSE stream is owned by the client rather than
 * driven by per-request notifications), its own `eventStreamReturn` cancel
 * hook for the SSE async iterator, and its own `shutdownTimeoutMs` guard
 * on `driver.close()` / `eventStreamReturn()`. The four adapters refactored
 * onto this harness all share a single "close driver → drain stream →
 * close queue" pattern that doesn't match OpenCode's two-stage driver +
 * generator teardown. Introducing OpenCode would force the base class to
 * leak SSE-specific concerns into a shape most adapters don't need.
 * When OpenCode migrates (if ever), it should fold its timeout guard into
 * `runShutdownSequence` and consume `AdapterHandleBase` the same way — but
 * that's deliberately out of scope for the initial extraction.
 *
 * ### Composition
 *
 * The module exports both composable helpers (`AdapterEventQueue`,
 * `PromptWatchdog`, `redactAgentEvent`, `runShutdownSequence`,
 * `withShutdownTimeout`) and an abstract `AdapterHandleBase` base class
 * that wires them together. Adapters that prefer a la carte helpers without
 * the base class can skip the inheritance; adapters that want the full
 * state-machine (Cursor/Gemini/Amp/Pi as of Phase 7) extend the base.
 */

// Import from @shamu/shared via subpath exports so consumers get the same
// branded types the existing adapters use.
import type { EventId, RunId, SessionId, TurnId } from "@shamu/shared/ids";
import type { Redactor } from "@shamu/shared/redactor";
import type { AgentHandle, HandleHeartbeat, UserTurn } from "./adapter.ts";
import type { Capabilities, PermissionMode } from "./capabilities.ts";
import { CorrelationState, type MonotonicClock } from "./correlation.ts";
import { type AgentEvent, validateEvent } from "./events.ts";

// ---------------------------------------------------------------------------
// Event queue
// ---------------------------------------------------------------------------

/**
 * Minimal single-consumer event queue. `push()` enqueues an event (dropped
 * after `close()`), `close()` wakes pending waiters with `done: true`, and
 * `iterate()` yields buffered + live events until closed.
 *
 * One consumer only — the handle pins the async iterator to its `events`
 * getter. Adapters wanting fan-out should compose a buffering tee on top;
 * the contract only requires an `AsyncIterable` that completes when the run
 * ends.
 */
export class AdapterEventQueue<E> {
  private readonly waiters: Array<(v: IteratorResult<E>) => void> = [];
  private readonly pending: E[] = [];
  private closed = false;

  push(ev: E): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) {
      w({ value: ev, done: false });
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

  isClosed(): boolean {
    return this.closed;
  }

  async *iterate(): AsyncIterableIterator<E> {
    while (true) {
      const buffered = this.pending.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<E>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Redact every user-visible string field of an `AgentEvent`. G1 contract
 * enforcement — every emitted event passes through this before validation.
 *
 * The switch is deliberately exhaustive: adding a new `AgentEvent` kind
 * surfaces as a TypeScript error here so adapters can't accidentally bypass
 * redaction by emitting a new kind without a redaction strategy.
 */
export function redactAgentEvent(ev: AgentEvent, redact: (s: string) => string): AgentEvent {
  switch (ev.kind) {
    case "reasoning":
      return { ...ev, text: redact(ev.text) };
    case "assistant_delta":
      return { ...ev, text: redact(ev.text) };
    case "assistant_message":
      return { ...ev, text: redact(ev.text), stopReason: redact(ev.stopReason) };
    case "tool_call":
      return { ...ev, args: redactUnknown(ev.args, redact) };
    case "tool_result":
      return { ...ev, summary: redact(ev.summary) };
    case "patch_applied":
      return ev;
    case "checkpoint":
      return { ...ev, summary: redact(ev.summary) };
    case "stdout":
    case "stderr":
      return { ...ev, text: redact(ev.text) };
    case "session_end":
      return { ...ev, reason: redact(ev.reason) };
    case "turn_end":
      return { ...ev, stopReason: redact(ev.stopReason) };
    case "usage":
      return { ...ev, model: redact(ev.model) };
    case "cost":
      return { ...ev, source: redact(ev.source) };
    case "error":
      return { ...ev, message: redact(ev.message), errorCode: redact(ev.errorCode) };
    case "session_start":
    case "permission_request":
    case "rate_limit":
    case "interrupt":
      return ev;
  }
}

/**
 * Recursive redaction for `tool_call.args`. Strings are redacted; arrays +
 * plain objects are walked; other scalars pass through unchanged.
 */
function redactUnknown(value: unknown, redact: (s: string) => string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactUnknown(v, redact));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactUnknown(v, redact);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Prompt watchdog
// ---------------------------------------------------------------------------

/**
 * Per-turn watchdog. `arm()` (re)starts a timeout; `clear()` cancels it;
 * `isArmed()` reports the current state. The callback is expected to run
 * the vendor-specific cancel path (cancelSession / abort / closeStdin) and
 * force a synthetic `turn_end` with `stopReason: "prompt_watchdog"`.
 */
export class PromptWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly timeoutMs: number,
    private readonly onFire: () => void,
  ) {}

  arm(): void {
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.onFire();
      } catch {
        // Watchdog callbacks must never throw past the handle.
      }
    }, this.timeoutMs);
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isArmed(): boolean {
    return this.timer !== null;
  }
}

// ---------------------------------------------------------------------------
// Shutdown helpers
// ---------------------------------------------------------------------------

/**
 * Await `promise` but give up after `ms` (ported from OpenCode PR #19 via
 * gemini-cli #6573 hang report). Always resolves; on timeout the returned
 * promise resolves while the underlying work continues best-effort. Used
 * inside `runShutdownSequence()` so an SDK-level hang can't block the
 * orchestrator from reaping state.
 */
export function withShutdownTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(undefined);
      });
  });
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface ShutdownSequenceOptions {
  /**
   * The driver/transport close. Always invoked first — reaping the
   * subprocess unblocks pending requests that would otherwise hang.
   */
  readonly closeDriver: () => Promise<void>;
  /**
   * Optional post-close drain step. Used by adapters that own an async
   * generator separate from the driver (e.g. Amp's stdout/stderr loops).
   */
  readonly drainStream?: () => Promise<void>;
  /**
   * Best-effort handler teardown. Each callback is invoked in a try/catch
   * block so a wedged unsubscribe doesn't block the queue close.
   */
  readonly unsubscribe?: readonly (() => void)[];
  /** Final queue close — invoked after drain + unsubscribe. */
  readonly closeQueue: () => void;
  /**
   * Upper bound (ms) per bounded stage. Default 5s. Set higher in
   * environments where the vendor's close path is slow.
   */
  readonly shutdownTimeoutMs?: number;
}

/**
 * Run the shared shutdown sequence. Ordering:
 *
 *  1. `closeDriver()`          — bounded (SDK hangs are possible)
 *  2. `drainStream?.()`        — bounded (post-close drain)
 *  3. `unsubscribe[]`          — best-effort (synchronous, swallowed)
 *  4. `closeQueue()`           — synchronous, always runs
 *
 * Errors in any bounded stage are swallowed; the contract is "best-effort
 * reap, then close the queue so consumers unblock". Orchestrators losing
 * control of their shutdown path is worse than a potentially-orphaned
 * subprocess — the OS reaps children on process exit.
 */
export async function runShutdownSequence(opts: ShutdownSequenceOptions): Promise<void> {
  const timeoutMs = opts.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  await withShutdownTimeout(
    (async () => {
      try {
        await opts.closeDriver();
      } catch {
        // best-effort
      }
    })(),
    timeoutMs,
  );
  if (opts.drainStream) {
    await withShutdownTimeout(
      (async () => {
        try {
          await opts.drainStream?.();
        } catch {
          // best-effort
        }
      })(),
      timeoutMs,
    );
  }
  if (opts.unsubscribe) {
    for (const fn of opts.unsubscribe) {
      try {
        fn();
      } catch {
        // best-effort
      }
    }
  }
  opts.closeQueue();
}

// ---------------------------------------------------------------------------
// AdapterHandleBase
// ---------------------------------------------------------------------------

/**
 * Minimum projection-state surface the base class needs. Each adapter's
 * richer state (bound session id, tool-call maps, cumulative text buffers,
 * etc.) extends this — the base only touches `turnOpen`, which drives the
 * `safeEnvelope()` / `forceTurnEnd()` invariants.
 */
export interface MinimalProjectionState {
  turnOpen: boolean;
}

export interface AdapterHandleBaseOptions<TProjState extends MinimalProjectionState> {
  readonly runId: RunId;
  readonly initialSessionId: SessionId | null;
  readonly vendor: string;
  /** Used in error messages (e.g. "CursorHandle.setPermissionMode: ..."). */
  readonly logLabel: string;
  readonly capabilities: Capabilities;
  readonly projState: TProjState;
  readonly sessionSource: "spawn" | "resume" | "fork";
  readonly redactor: Redactor;
  readonly initialModel: string;
  readonly promptTimeoutMs: number;
  readonly clock?: MonotonicClock | undefined;
  readonly newEventId?: (() => EventId) | undefined;
  readonly newTurnId?: (() => TurnId) | undefined;
}

/**
 * Shared state-machine for the Cursor / Gemini / Amp / Pi adapter handles.
 *
 * Subclasses own:
 *   - The vendor payload shape for `send()`
 *   - The vendor cancel call for `interrupt()` and the watchdog
 *   - Any vendor-specific `setModel()` RPC
 *   - Wiring the driver's event streams to `emit()` / `emitSafely()`
 *   - Their own `shutdown()` that delegates to `runShutdownSequence()`
 *
 * The base class owns:
 *   - `runId` + G8 enforcement at construction
 *   - `CorrelationState` threading + envelope helpers
 *   - The redactor pipeline on every emitted event (G1)
 *   - The event queue + `events` async iterable
 *   - The 10-minute `PromptWatchdog` arm/clear lifecycle
 *   - `forceTurnEnd()` (usage + cost + turn_end emission on error paths)
 *   - `heartbeat()`, `setModel()` (local-only default), `setPermissionMode()`
 *
 * `TProjState extends MinimalProjectionState` preserves each adapter's
 * richer projection shape — callers reach into `this.projState` with the
 * full vendor type, not the minimum surface.
 */
export abstract class AdapterHandleBase<TProjState extends MinimalProjectionState>
  implements AgentHandle
{
  public readonly runId: RunId;
  protected _sessionId: SessionId | null;
  protected readonly corr: CorrelationState;
  protected readonly projState: TProjState;
  protected readonly queue = new AdapterEventQueue<AgentEvent>();
  protected readonly redactor: Redactor;
  protected readonly capabilities: Capabilities;
  protected readonly sessionSource: "spawn" | "resume" | "fork";
  protected readonly promptTimeoutMs: number;
  protected readonly logLabel: string;
  protected readonly watchdog: PromptWatchdog;

  protected currentModel: string;
  protected lastEventAt = 0;
  protected turnActive = false;
  protected closed = false;

  protected constructor(options: AdapterHandleBaseOptions<TProjState>) {
    // G8 — runId is orchestrator-owned. Enforced here so every subclass
    // benefits without repeating the check.
    if (!options.runId) {
      throw new Error(`${options.logLabel}: runId is required (G8)`);
    }
    this.runId = options.runId;
    this._sessionId = options.initialSessionId;
    this.capabilities = options.capabilities;
    this.redactor = options.redactor;
    this.currentModel = options.initialModel;
    this.sessionSource = options.sessionSource;
    this.promptTimeoutMs = options.promptTimeoutMs;
    this.logLabel = options.logLabel;
    this.projState = options.projState;

    this.corr = new CorrelationState({
      runId: this.runId,
      sessionId: this._sessionId,
      vendor: options.vendor,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.newEventId ? { newEventId: options.newEventId } : {}),
      ...(options.newTurnId ? { newTurnId: options.newTurnId } : {}),
    });

    this.watchdog = new PromptWatchdog(this.promptTimeoutMs, () => {
      if (this.closed || !this.turnActive) return;
      this.onWatchdogFire();
    });
  }

  // -- AgentHandle surface -------------------------------------------------

  get sessionId(): SessionId | null {
    return this._sessionId;
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.queue.iterate();
  }

  heartbeat(): HandleHeartbeat {
    return { lastEventAt: this.lastEventAt, seq: this.corr.peekSeq() };
  }

  /**
   * Default `setModel`: stash the value locally for `usage` stamping.
   * Adapters that support a mid-session RPC (Gemini, Pi) override this.
   */
  async setModel(model: string): Promise<void> {
    if (typeof model !== "string" || model.length === 0) {
      throw new Error(`${this.logLabel}.setModel: model must be a non-empty string`);
    }
    this.currentModel = model;
  }

  /**
   * Default `setPermissionMode`: validate the mode against the adapter's
   * capability manifest. Mid-session permission-mode changes aren't
   * supported by any refactored adapter today; the call succeeds as a
   * no-op for declared modes so the contract surface stays consistent.
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.capabilities.permissionModes.includes(mode)) {
      throw new Error(`${this.logLabel}.setPermissionMode: ${mode} not declared in capabilities`);
    }
  }

  abstract send(message: UserTurn): Promise<void>;
  abstract interrupt(reason?: string): Promise<void>;
  abstract shutdown(reason: string): Promise<void>;

  // -- Abstract hooks subclasses MUST implement ---------------------------

  /**
   * Fire the vendor-specific cancel path + force a synthetic turn_end.
   * Invoked when the per-turn watchdog timer expires. Typical body:
   *
   *   void this.driver.client.cancelSession(this._sessionId).catch(() => {});
   *   this.forceTurnEnd("prompt_watchdog");
   */
  protected abstract onWatchdogFire(): void;

  // -- Protected helpers subclasses reach into ----------------------------

  /**
   * Update the tracked vendor session id. Called by the projector hook
   * (`onSessionBound`) once the real id lands.
   */
  protected bindSessionId(sessionId: SessionId): void {
    this._sessionId = sessionId;
  }

  /**
   * Emit an event through the full redact → validate → queue pipeline.
   * `tsWall` from the validated event is stashed as `lastEventAt` for the
   * heartbeat surface. Throws if validation fails; callers that want to
   * keep shutdown moving should use `emitSafely()`.
   */
  protected emit(raw: AgentEvent): void {
    const redacted = redactAgentEvent(raw, (s) => this.redactor.redact(s));
    const validated = validateEvent(redacted);
    this.lastEventAt = validated.tsWall;
    this.queue.push(validated);
  }

  /** Same as `emit()` but swallows envelope/validation wedges. */
  protected emitSafely(raw: AgentEvent): void {
    try {
      this.emit(raw);
    } catch {
      // validation/envelope wedged; swallow so shutdown completes.
    }
  }

  /**
   * Produce a well-formed envelope even if no turn is currently open.
   * Opens a micro-turn as needed. Used by error paths where the regular
   * `this.corr.envelope()` would throw. Subclasses call this when emitting
   * `error` / `session_end` outside an active turn.
   */
  protected safeEnvelope() {
    if (!this.projState.turnOpen) {
      this.corr.startTurn();
      this.projState.turnOpen = true;
    }
    return this.corr.envelope();
  }

  /**
   * Start a new turn + arm the prompt watchdog. Called at the top of
   * subclass `send()` after the `closed` / `turnActive` checks pass.
   */
  protected beginTurn(): void {
    this.turnActive = true;
    this.watchdog.arm();
  }

  /**
   * Watch a fire-and-forget prompt promise. On resolution, run
   * `onResolved` (typically the usage/cost/turn_end emission from a result
   * payload). On rejection, surface a typed `error` event + force the
   * turn to end. Both branches are guarded by the `closed` flag so a late
   * resolution after shutdown is a no-op.
   *
   * Shared helper for Cursor, Gemini, Pi's fire-and-handle-async send()
   * paths. Amp writes a line to stdin synchronously and doesn't need this.
   */
  protected watchPromptPromise<R>(
    promise: Promise<R>,
    opts: {
      readonly onResolved: (value: R) => void;
      readonly errorCode: string;
      readonly stopReasonOnError?: string;
    },
  ): void {
    promise
      .then((value) => {
        if (!this.closed) opts.onResolved(value);
      })
      .catch((cause) => {
        if (this.closed) return;
        this.emitSafely({
          ...this.safeEnvelope(),
          kind: "error",
          fatal: true,
          errorCode: opts.errorCode,
          message: this.redactor.redact((cause as Error)?.message ?? String(cause)),
          retriable: false,
        });
        this.forceTurnEnd(opts.stopReasonOnError ?? "prompt_error");
      });
  }

  /**
   * Shared interrupt body: emit the `interrupt` envelope (opening a micro-
   * turn if needed), invoke the vendor-specific cancel path best-effort,
   * then force the current turn to synthesize a terminal `turn_end` so the
   * consumer's for-await advances. Subclasses wrap this with their vendor
   * cancel callback.
   */
  protected async doInterrupt(
    reason: string | undefined,
    cancel: () => Promise<void>,
  ): Promise<void> {
    if (this.closed) return;
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
      try {
        this.emit({
          ...this.corr.envelope(),
          kind: "interrupt",
          requestedBy: "user",
          delivered: false,
        });
      } catch {
        // envelope wedged
      }
    }
    try {
      await cancel();
    } catch {
      // best-effort
    }
    this.forceTurnEnd(reason ?? "interrupted");
  }

  /**
   * Force a synthetic `usage` + `cost` + `turn_end` emission and close
   * the current turn. If no turn is open the watchdog is disarmed and the
   * method returns without emitting anything (matching the existing
   * Cursor / Gemini / Amp / Pi behavior).
   *
   * The emitted stop reason is supplied by the caller (`prompt_error`,
   * `prompt_watchdog`, `path_scope_violation`, etc.). `stdin_error` /
   * vendor-specific variants are preserved verbatim.
   */
  protected forceTurnEnd(stopReason: string): void {
    if (!this.projState.turnOpen) {
      this.turnActive = false;
      this.watchdog.clear();
      return;
    }
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
      // envelope wedged
    }
    this.projState.turnOpen = false;
    this.turnActive = false;
    this.watchdog.clear();
  }

  /**
   * Common shutdown body. Emits a best-effort `session_end` inside a valid
   * envelope, then drives the shared `runShutdownSequence` teardown. The
   * `closed` flag is flipped early so any late-arriving events are dropped
   * without racing the queue close.
   *
   * Subclasses call this from their `shutdown()` override with their
   * driver close, per-stream drain, and subscription-cancel callbacks.
   */
  protected async runSharedShutdown(
    reason: string,
    opts: {
      readonly closeDriver: () => Promise<void>;
      readonly drainStream?: () => Promise<void>;
      readonly unsubscribe?: readonly (() => void)[];
      readonly shutdownTimeoutMs?: number;
    },
  ): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watchdog.clear();
    // session_end envelope FIRST — consumers should see it before the
    // queue closes. Open a micro-turn if none is active so the envelope
    // is well-formed.
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
      // envelope state wedged — queue-close is the contract.
    }
    await runShutdownSequence({
      closeDriver: opts.closeDriver,
      ...(opts.drainStream ? { drainStream: opts.drainStream } : {}),
      ...(opts.unsubscribe ? { unsubscribe: opts.unsubscribe } : {}),
      closeQueue: () => this.queue.close(),
      ...(opts.shutdownTimeoutMs !== undefined
        ? { shutdownTimeoutMs: opts.shutdownTimeoutMs }
        : {}),
    });
  }
}
