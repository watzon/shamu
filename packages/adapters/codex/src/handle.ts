/**
 * `CodexHandle` — the live `AgentHandle` implementation.
 *
 * Responsibilities:
 * - Wire `Thread.runStreamed({user_message})` for each `send()`.
 * - Project the SDK's JSONL event stream through `projectCodexEvent` into
 *   schema-compliant `AgentEvent`s and enqueue them for the consumer.
 * - Apply `Redactor` to every string-valued payload before queueing so no
 *   secret ever leaves the adapter verbatim (G1 from threat model).
 * - Enforce `PathScope` and `ShellGate` on `item.started` events before the
 *   SDK's tool dispatch can side-effect the filesystem or shell (G4/G5).
 * - Surface heartbeat, cooperative interrupt via AbortController, setModel,
 *   setPermissionMode, shutdown.
 *
 * Concurrency model: at most one live turn per handle. `send()` is rejected
 * while a turn is in flight (mirrors echo's contract so the supervisor
 * stays authoritative about dispatch ordering).
 */

import type { ThreadEvent } from "@openai/codex-sdk";
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
import {
  type CodexProjectionHooks,
  type CodexProjectionState,
  createProjectionState,
  type ProjectionLogger,
  projectCodexEvent,
} from "./jsonl-projection.ts";
import { decidePermission, type PermissionHandlerOptions } from "./permission-handler.ts";

/**
 * Minimum surface of a `Thread` we actually call into. Declaring it here
 * lets unit tests hand us a scripted double without pulling in the real
 * SDK — and lets the adapter work against a future SDK shape that adds
 * fields we don't care about.
 */
export interface ThreadLike {
  readonly id: string | null;
  runStreamed(
    input: string,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}

/**
 * Constructor options for `CodexHandle`. `clock` + `eventIdFactory` are
 * primarily for tests; `redactor` lets callers pre-register run-local
 * secrets before the handle starts emitting.
 */
export interface CodexHandleOptions {
  readonly thread: ThreadLike;
  readonly opts: SpawnOpts;
  readonly vendor: string;
  readonly capabilities: Capabilities;
  readonly resumedSessionId?: SessionId | undefined;
  readonly clock?: MonotonicClock | undefined;
  readonly eventIdFactory?: (() => EventId) | undefined;
  readonly turnIdFactory?: (() => TurnId) | undefined;
  /**
   * Optional deterministic tool-call id factory. Tests pin this for
   * snapshot stability; production leaves it unset (uses `newToolCallId`).
   */
  readonly toolCallIdFactory?: (() => ToolCallId) | undefined;
  readonly redactor?: Redactor | undefined;
  readonly logger?: ProjectionLogger | undefined;
}

class CodexEventQueue {
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

interface ActiveTurn {
  readonly abort: AbortController;
  /** Resolves when the projector finishes draining this turn's events. */
  readonly done: Promise<void>;
}

export class CodexHandle implements AgentHandle {
  public readonly runId: RunId;
  private _sessionId: SessionId | null;
  private readonly thread: ThreadLike;
  private readonly corr: CorrelationState;
  private readonly queue = new CodexEventQueue();
  private readonly redactor: Redactor;
  private readonly projState: CodexProjectionState;
  private readonly projLogger: ProjectionLogger;
  private readonly projHooks: CodexProjectionHooks;
  private readonly capabilities: Capabilities;
  private readonly permissionOpts: PermissionHandlerOptions;
  private readonly sessionSource: "spawn" | "resume";

  private currentModel: string;
  private lastEventAt = 0;
  private activeTurn: ActiveTurn | null = null;
  private shuttingDown = false;
  private closed = false;

  constructor(options: CodexHandleOptions) {
    // G8 — `runId` is orchestrator-owned. The handle MUST surface the caller
    // supplied id; a mismatch trips the CLI's refusal logic.
    this.runId = options.opts.runId;
    this._sessionId = options.resumedSessionId ?? null;
    this.thread = options.thread;
    this.capabilities = options.capabilities;
    this.redactor = options.redactor ?? new Redactor();
    this.projLogger = options.logger ?? (() => {});
    this.projState = createProjectionState();
    this.currentModel = options.opts.model ?? "codex-default";
    this.sessionSource = options.resumedSessionId ? "resume" : "spawn";

    this.corr = new CorrelationState({
      runId: this.runId,
      sessionId: this._sessionId,
      vendor: options.vendor,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.eventIdFactory ? { newEventId: options.eventIdFactory } : {}),
      ...(options.turnIdFactory ? { newTurnId: options.turnIdFactory } : {}),
    });

    // Hook bundle handed to the projector. `modelProvider` closes over
    // `this.currentModel` so the projector's `usage` event always
    // reflects the handle's latest `setModel(...)` call. The tool-call id
    // factory is only set when the caller pinned one (tests).
    this.projHooks = {
      modelProvider: () => this.currentModel,
      ...(options.toolCallIdFactory ? { newToolCallId: options.toolCallIdFactory } : {}),
    };

    this.permissionOpts = {
      worktreeRoot: options.opts.cwd,
    };

    // On resume, the SDK won't re-emit `thread.started` — the session id is
    // already known. Seed the projection state so `session_start` fires on
    // the first turn anyway (contract's `resume-warm` scenario asserts a
    // session_start is present on the resumed stream).
    if (options.resumedSessionId) {
      this.projState.threadId = options.resumedSessionId;
      // Do NOT set sessionStartEmitted; the handle emits a synthetic
      // session_start with source=resume on the first send() — see
      // emitResumeSessionStart().
    }
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
    if (this.closed) throw new Error("CodexHandle: send() after shutdown()");
    if (this.activeTurn) {
      throw new Error("CodexHandle: send() while a turn is already active");
    }
    const abort = new AbortController();
    // Kick the SDK stream; we don't await its completion — we expose the
    // event stream through the queue and return from send() promptly.
    const done = this.runTurn(message, abort.signal);
    this.activeTurn = { abort, done };
  }

  private async runTurn(message: UserTurn, signal: AbortSignal): Promise<void> {
    try {
      // Emit a synthetic session_start on resume turns BEFORE the SDK
      // stream opens. On spawn paths, `thread.started` does this job; on
      // resume it's never emitted and the handle owes one to its consumer.
      if (this.sessionSource === "resume" && !this.projState.sessionStartEmitted) {
        this.emitResumeSessionStart();
      }
      const redactedText = this.redactor.redact(message.text);
      const streamed = await this.thread.runStreamed(redactedText, { signal });
      // Thread id becomes known the moment runStreamed returns in some
      // paths (the SDK patches `thread.started` into the first yielded
      // event). We defer binding to the projector which sees every event.
      let projectedAny = false;
      for await (const raw of streamed.events) {
        projectedAny = true;
        this.handleRawEvent(raw);
        if (this.shuttingDown) break;
      }
      // Bind session id surfaced by the projector (thread.started fired).
      if (!this._sessionId && this.projState.threadId) {
        this._sessionId = this.projState.threadId;
      }
      // Empty-stream guard. A few failure modes produce a zero-event SDK
      // stream that exits cleanly: Codex's git-repo-check refusing a
      // non-trusted cwd (fixed upstream by `skipGitRepoCheck: true` in
      // `index.ts`, but we defend in depth here for future refusal
      // modes), a vendor binary that prints a diag to stdout and exits
      // 0, or a session that was killed before its first event landed.
      // Without this branch the consumer's `for await (handle.events)`
      // never terminates — the queue stays open waiting for more
      // pushes, and nothing will ever push. Emit a synthetic error +
      // turn_end so the iterator can drain and surface the refusal.
      if (!projectedAny && !this.shuttingDown && !signal.aborted) {
        this.enqueueError(
          "vendor_empty_stream",
          "Codex SDK stream closed with zero events. " +
            "Common causes: vendor CLI refused to run in this working directory " +
            "(trusted-directory check, non-git cwd), or the vendor binary exited " +
            "cleanly without emitting JSONL. Check the worktree path and auth state.",
        );
      }
      // Defensive: if the SDK generator completed without emitting a
      // `turn.completed` / `turn.failed`, the projector's `turnOpen` flag
      // is still set and the consumer is stuck waiting for a `turn_end`.
      // Emit a synthetic usage/cost/turn_end so the iterable progresses.
      // Real turn.completed events hit `turnOpen=false` before we get
      // here, so this branch only fires on aborted/abnormal streams.
      //
      // With `auto-open` semantics on `emitSyntheticTurnEnd`, we also
      // close the iterator on the zero-event path — `projState.turnOpen`
      // is false there too, but the helper opens a fresh turn so the
      // envelope is well-formed.
      const needsSyntheticTail = (this.projState.turnOpen || !projectedAny) && !this.shuttingDown;
      if (needsSyntheticTail) {
        const reason = projectedAny ? "stream_closed" : "vendor_empty_stream";
        this.emitSyntheticTurnEnd(reason);
      }
    } catch (cause) {
      // Only surface the error if we're not in a shutdown path (shutdown
      // already emits a session_end; double-emit would violate schema
      // ordering invariants). `AbortError` from our own signal is the
      // expected cooperative-interrupt completion, not a failure — and
      // the interrupt() path has already emitted its synthetic tail.
      if (signal.aborted || this.shuttingDown) {
        // Intentional no-op — nothing to do. The turn tail is already
        // closed (interrupt path) or will be closed by shutdown().
      } else {
        this.enqueueError("stream_error", (cause as Error)?.message ?? String(cause));
        // Always close the iterator on a caught error so the consumer's
        // `for await` exits. `emitSyntheticTurnEnd` opens a synthetic
        // turn when one is not already open; without that we'd leak the
        // queue on pre-first-event failures (e.g. the SDK throwing a
        // JSON-parse error on the "Reading prompt from stdin..."
        // plaintext line the Codex CLI emits when its git-repo-check
        // refuses).
        this.emitSyntheticTurnEnd("stream_error");
      }
    } finally {
      this.activeTurn = null;
    }
  }

  /**
   * Emit a synthetic usage/cost/turn_end triple so the consumer's loop
   * can exit when the SDK failed to produce a `turn.completed`. Used on
   * abnormal stream closure, on pre-first-event failure, and on
   * interrupt.
   *
   * Auto-opens a synthetic session_start + turn when the projector has
   * not seen real events — covers the empty-stream failure mode where
   * the vendor CLI exits 0 without emitting any JSONL (Codex
   * trusted-directory refusal, pre-handshake crash). Without this
   * auto-open the adapter would never emit the triple on pre-thread
   * failures and the consumer's `for await` would hang forever waiting
   * on a queue that no one pushes to.
   */
  private emitSyntheticTurnEnd(stopReason: string): void {
    this.ensureSyntheticFrame();
    try {
      this.enqueue({
        ...this.corr.envelope(),
        kind: "usage",
        model: this.currentModel,
        tokens: { input: 0, output: 0 },
        cache: { hits: 0, misses: 0 },
      });
      this.enqueue({
        ...this.corr.envelope(),
        kind: "cost",
        usd: null,
        confidence: "unknown",
        source: "subscription",
      });
      this.enqueue({
        ...this.corr.envelope(),
        kind: "turn_end",
        stopReason,
        durationMs: 0,
      });
      this.corr.endTurn();
      this.projState.turnOpen = false;
      this.projState.turnStartedAtMonotonic = null;
    } catch {
      // Envelope threw despite ensureSyntheticFrame() (should be
      // unreachable). Swallow — the iterable will close when the queue
      // does, at shutdown().
    }
  }

  /**
   * Ensure a synthetic session_start + open turn are in place so the
   * next envelope call succeeds. Called before any auto-open emission
   * path (`enqueueError`, `emitSyntheticTurnEnd`). Idempotent — no-op
   * when a turn is already open.
   */
  private ensureSyntheticFrame(): void {
    if (this.projState.turnOpen) return;
    // Open a turn FIRST so the session_start envelope is well-formed
    // (envelope() requires an active turn).
    this.corr.startTurn();
    this.projState.turnOpen = true;
    if (!this.projState.sessionStartEmitted) {
      this.projState.sessionStartEmitted = true;
      try {
        this.enqueue({
          ...this.corr.envelope(),
          // `source: "spawn"` even on synthetic frames from the spawn
          // path; on resume the earlier emitResumeSessionStart() would
          // have already set sessionStartEmitted=true.
          kind: "session_start",
          source: this.sessionSource,
        });
      } catch {
        // Envelope threw; continue — the subsequent turn_end still
        // closes the iterator.
      }
    }
  }

  private handleRawEvent(raw: ThreadEvent): void {
    // G4/G5 — path-scope + shell gate. Runs BEFORE we project the event,
    // because a denied item still fires a `tool_call` event (so callers
    // can correlate the rejection) plus an immediate `error` event and
    // then aborts the turn.
    if (raw.type === "item.started") {
      const decision = decidePermission(raw.item, this.permissionOpts);
      if (decision && decision.kind === "denied") {
        // Project the started event so the caller sees the tool_call; then
        // emit an error and abort the turn so the SDK stops dispatching.
        this.projectAndEnqueue(raw);
        this.enqueueError(decision.error.code, decision.error.message);
        this.activeTurn?.abort.abort(decision.error);
        return;
      }
    }
    this.projectAndEnqueue(raw);
  }

  private projectAndEnqueue(raw: ThreadEvent): void {
    const projected = projectCodexEvent(
      raw,
      this.corr,
      this.projState,
      this.projLogger,
      this.projHooks,
    );
    for (const ev of projected) {
      this.enqueue(ev);
    }
  }

  /**
   * Synthesize a `session_start` with `source: "resume"` when a resumed
   * handle begins streaming. Mirrors echo's behavior so the contract
   * suite's `resume-warm` scenario passes without vendor-specific wiring.
   */
  private emitResumeSessionStart(): void {
    this.projState.sessionStartEmitted = true;
    // Open a turn so the session_start envelope is well-formed. The
    // projector's normal `turn.started` handling will no-op on the
    // upcoming open because `turnOpen` is already set; we rely on the
    // first SDK event to stamp real content into the turn.
    this.corr.startTurn();
    this.projState.turnOpen = true;
    const envelope = this.corr.envelope();
    this.enqueue({
      ...envelope,
      kind: "session_start",
      source: "resume",
    });
  }

  private enqueueError(errorCode: string, message: string): void {
    // Ensure an envelope is valid: open a synthetic frame if no turn is
    // currently open. Without this, a pre-first-event failure (SDK
    // JSON-parse throw before thread.started) has no envelope and the
    // error event is silently dropped — the consumer sees nothing and
    // hangs on the iterator.
    this.ensureSyntheticFrame();
    try {
      const envelope = this.corr.envelope();
      this.enqueue({
        ...envelope,
        kind: "error",
        fatal: true,
        errorCode,
        message: this.redactor.redact(message),
        retriable: false,
      });
    } catch {
      // Unreachable after ensureSyntheticFrame — defensive fall-through.
    }
  }

  private enqueue(ev: AgentEvent): void {
    const redacted = this.redactEvent(ev);
    const validated = validateEvent(redacted);
    this.lastEventAt = validated.tsWall;
    this.queue.push(validated);
  }

  /**
   * Deep-redact every string payload on the event before it's pushed.
   *
   * The envelope's `eventId`/`runId`/etc. are ULIDs/ints and cannot carry
   * a secret, so we only touch the kind-specific fields. A central
   * `walk(o)` would be simpler but costs more per event (JSON traversal,
   * allocations); we open-code per kind so the hot path stays lean.
   */
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
        // `files` are worktree-relative paths; they can't carry secrets
        // any more than a filename can. No change.
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

  async interrupt(reason?: string): Promise<void> {
    if (this.closed) return;
    // No active turn, no projector turn open → emit a solitary
    // interrupt event inside a micro-turn so the contract's interrupt
    // scenario still observes the event shape even when the vendor
    // stream already completed before we were asked.
    if (!this.activeTurn && !this.projState.turnOpen) {
      this.corr.startTurn();
      this.projState.turnOpen = true;
      try {
        this.enqueue({
          ...this.corr.envelope(),
          kind: "interrupt",
          requestedBy: "user",
          delivered: false,
        });
      } catch {
        // fall through
      }
      this.emitSyntheticTurnEnd(reason ?? "interrupted");
      return;
    }
    // Emit the interrupt event inside the live turn. `delivered: true`
    // when we have an SDK stream to abort; `false` when the stream has
    // already closed but the projector's turn is still open.
    try {
      this.enqueue({
        ...this.corr.envelope(),
        kind: "interrupt",
        requestedBy: "user",
        delivered: this.activeTurn !== null,
      });
    } catch {
      // No turn; nothing to do.
    }
    // Abort the SDK stream if one is still running. The runTurn
    // `finally` block will eventually emit its own synthetic turn_end;
    // we don't pre-emit one here because that would produce duplicate
    // turn_end events.
    this.activeTurn?.abort.abort(new Error(reason ?? "cooperative-interrupt"));
    // If no SDK stream is live but the projector turn is still open
    // (e.g., the vendor stream ended with an item.started but no
    // turn.completed and then the consumer called interrupt()), close
    // the turn synthetically so the consumer can observe the tail.
    if (!this.activeTurn && this.projState.turnOpen) {
      this.emitSyntheticTurnEnd(reason ?? "interrupted");
    }
  }

  async setModel(model: string): Promise<void> {
    if (typeof model !== "string" || model.length === 0) {
      throw new Error("CodexHandle.setModel: model must be a non-empty string");
    }
    // The Codex SDK's `model` is scoped at Thread construction. Changing
    // it mid-thread isn't supported by the SDK — we stash the value so
    // subsequent `usage` events report the new id, and surface a warning
    // the first time the consumer expects a fresh thread (`resume` with
    // a different model would pick this up).
    this.currentModel = model;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.capabilities.permissionModes.includes(mode)) {
      throw new Error(`CodexHandle.setPermissionMode: ${mode} not declared in capabilities`);
    }
    // Codex's CLI surfaces approval policy via `--config approval_policy=...`
    // at thread construction. Mid-thread mode changes would require a fresh
    // thread; a supervisor that wants to change modes should call
    // `adapter.resume(sessionId, { permissionMode: mode })` on a new
    // handle. We validate the mode here and accept the call as a no-op
    // for the current handle.
  }

  async shutdown(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.shuttingDown = true;
    // Abort any live turn so the SDK generator finishes.
    if (this.activeTurn) {
      this.activeTurn.abort.abort(new Error(reason));
      try {
        await this.activeTurn.done;
      } catch {
        // Drain errors are expected after abort.
      }
      this.activeTurn = null;
    }
    // Best-effort session_end. Open a fresh turn if we're outside one so
    // the envelope call succeeds; swallow if that fails — the queue close
    // is the contract.
    try {
      if (!this.projState.turnOpen) {
        this.corr.startTurn();
        this.projState.turnOpen = true;
      }
      this.enqueue({
        ...this.corr.envelope(),
        kind: "session_end",
        reason,
      });
      this.corr.endTurn();
      this.projState.turnOpen = false;
    } catch {
      // fall through
    }
    this.queue.close();
  }
}
