/**
 * `@shamu/adapter-echo` — pure in-memory stub `AgentAdapter`.
 *
 * Drives a scripted event stream from the prompt text. The full CLI →
 * supervisor-stub → adapter → SQLite pipeline can smoke-test itself against
 * this adapter without any subprocess or vendor call.
 *
 * Design notes:
 * - Every event runs through `@shamu/adapters-base/events` validation so a
 *   schema drift in `@shamu/shared/events` trips the adapter's unit tests
 *   immediately.
 * - Every payload field that's a string runs through the central
 *   `Redactor` from `@shamu/shared/redactor` — matches the acceptance-
 *   criteria "Secret redaction" row, and satisfies the `secret-redaction`
 *   contract scenario.
 * - A `Clock` is injected; the default uses `process.hrtime.bigint()` via
 *   `CorrelationState`'s `defaultClock`, but tests can pin a deterministic
 *   clock so replays don't flake.
 * - `AsyncIterable` implementation uses a tiny queue that supports a single
 *   consumer. The contract suite only ever has one consumer per handle;
 *   adapters that need multi-cast layer it above the handle.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentAdapter,
  type AgentEvent,
  type AgentHandle,
  type Capabilities,
  CorrelationState,
  freezeCapabilities,
  type HandleHeartbeat,
  type MonotonicClock,
  type PermissionMode,
  type SpawnOpts,
  type UserTurn,
  validateEvent,
} from "@shamu/adapters-base";
import {
  type EventId,
  newSessionId,
  newToolCallId,
  type RunId,
  type SessionId,
  type ToolCallId,
} from "@shamu/shared/ids";
import { Redactor } from "@shamu/shared/redactor";
import { chooseScript, type Script, type Step } from "./script.ts";

export type { Script, Step } from "./script.ts";
export { chooseScript, PLANTED_SECRET_TOKEN, SCRIPTS } from "./script.ts";
export { echoVendorCliDescriptor } from "./vendor-cli-descriptor.ts";

/** Load the capability manifest relative to this module's source layout. */
function loadEchoCapabilities(): Readonly<Capabilities> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "capabilities.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return freezeCapabilities(raw);
}

/**
 * The echo adapter's frozen capability manifest. Loaded once at module load
 * time — per PLAN.md G8, capabilities are immutable across runs.
 */
export const ECHO_CAPABILITIES: Readonly<Capabilities> = loadEchoCapabilities();

/**
 * Options accepted by `new EchoAdapter(opts)`. All fields are optional;
 * the defaults produce a deterministic, realistic stream.
 */
export interface EchoAdapterOptions {
  /** Override the monotonic clock. Tests pin this for deterministic ts. */
  readonly clock?: MonotonicClock;
  /** Override the ULID factory. Tests pin this for deterministic ids. */
  readonly newEventId?: () => EventId;
  /**
   * Optional redactor instance. If omitted a fresh `Redactor` is created per
   * handle. Pass one in if you want to pre-register additional secrets.
   */
  readonly redactor?: Redactor;
  /**
   * Fixed vendor label. Defaults to `"echo"`. Test suites can override to
   * thread distinct labels through if they share a SQLite DB.
   */
  readonly vendor?: string;
}

/**
 * A tiny single-consumer async queue — the echo handle's `events` iterator.
 *
 * Properties:
 * - `push(ev)` enqueues; if a waiter is parked on `iterate().next()`, it
 *   resolves immediately without heap overhead.
 * - `close()` completes the iterator cleanly. Safe to call multiple times.
 * - One iterator per instance is assumed; the contract suite never
 *   multi-consumes, and if a future caller does, the second iterator will
 *   starve (documented in the class doc for transparency).
 */
class EventQueue {
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
  readonly script: Script;
  /** Index of the next step to consume. */
  cursor: number;
  /** Set to true when `park` is encountered; `interrupt()` flips it back. */
  parked: boolean;
}

/**
 * The live `AgentHandle` implementation.
 *
 * Lifecycle:
 *   construct → first `send()` → emits `session_start` lazily inside the
 *   turn's envelope sequence (so every event belongs to a turn, preserving
 *   the invariant the base package asserts) → walks the chosen script →
 *   `turn_end`. Subsequent `send()`s repeat the cycle.
 *
 * `shutdown(reason)` emits a best-effort `session_end` inside a fresh turn
 * (needed because `CorrelationState.envelope()` throws outside a turn) and
 * closes the event queue.
 */
class EchoHandle implements AgentHandle {
  public readonly runId: RunId;
  private _sessionId: SessionId | null;
  private readonly corr: CorrelationState;
  private readonly queue = new EventQueue();
  private readonly redactor: Redactor;
  private currentModel: string;
  private lastEventAt = 0;
  private sessionStartEmitted = false;
  private closed = false;
  private readonly sessionSource: "spawn" | "resume" | "fork";
  private activeTurn: ActiveTurn | null = null;

  constructor(
    sessionId: SessionId | null,
    vendor: string,
    opts: SpawnOpts,
    clock: MonotonicClock | undefined,
    eventIdFactory: (() => EventId) | undefined,
    redactor: Redactor,
  ) {
    // Phase 2+: runId is orchestrator-owned and threaded through SpawnOpts.
    // Echo used to mint its own; now it must consume the supplied id so
    // the supervisor remains authoritative (G8 from threat model).
    this.runId = opts.runId;
    this._sessionId = sessionId;
    this.currentModel = opts.model ?? "echo-default";
    this.redactor = redactor;
    this.sessionSource = sessionId ? "resume" : "spawn";
    this.corr = new CorrelationState({
      runId: this.runId,
      sessionId,
      vendor,
      ...(clock ? { clock } : {}),
      ...(eventIdFactory ? { newEventId: eventIdFactory } : {}),
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
    if (this.closed) throw new Error("EchoHandle: send() after shutdown()");
    if (this.activeTurn && !this.activeTurn.parked) {
      throw new Error("EchoHandle: send() while a turn is already active");
    }
    // If we are in a parked interrupt-awaiting turn, abort it first.
    if (this.activeTurn?.parked) {
      this.activeTurn = null;
    }
    this.corr.startTurn();
    const script = chooseScript(message.text);
    this.activeTurn = { script, cursor: 0, parked: false };
    // Schedule the script walk on a microtask so `send()` resolves promptly
    // and consumers can start iterating before the first event lands — this
    // mirrors how a real vendor adapter would buffer events.
    queueMicrotask(() => this.walk());
  }

  private walk(): void {
    if (!this.activeTurn || this.closed) return;

    // Emit `session_start` lazily on the first step of the first turn; it
    // shares the current turn's envelope sequence so every event carries
    // a turnId (invariant from `CorrelationState`).
    if (!this.sessionStartEmitted) {
      this.sessionStartEmitted = true;
      if (!this._sessionId) {
        this._sessionId = newSessionId();
        this.corr.bindSession(this._sessionId);
      }
      this.emit({
        ...this.corr.envelope(),
        kind: "session_start",
        source: this.sessionSource,
      });
    }

    while (this.activeTurn && this.activeTurn.cursor < this.activeTurn.script.steps.length) {
      const step = this.activeTurn.script.steps[this.activeTurn.cursor];
      if (!step) break;
      this.activeTurn.cursor += 1;
      if (step.kind === "park") {
        this.activeTurn.parked = true;
        return;
      }
      this.emitStep(step);
      if (step.kind === "turn_end") {
        this.corr.endTurn();
        this.activeTurn = null;
        return;
      }
    }
  }

  /**
   * Build an `AgentEvent` from a `Step`, run every string field through the
   * redactor, validate the result against the shared Zod schema, and enqueue.
   */
  private emitStep(step: Step): void {
    const redact = (s: string): string => this.redactor.redact(s);
    const redactArgs = (args: Readonly<Record<string, unknown>>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args)) {
        out[k] = typeof v === "string" ? redact(v) : v;
      }
      return out;
    };

    switch (step.kind) {
      case "reasoning":
        this.emit({
          ...this.corr.envelope(),
          kind: "reasoning",
          text: redact(step.text),
        });
        return;
      case "assistant_delta":
        this.emit({
          ...this.corr.envelope(),
          kind: "assistant_delta",
          text: redact(step.text),
        });
        return;
      case "assistant_message":
        this.emit({
          ...this.corr.envelope(),
          kind: "assistant_message",
          text: redact(step.text),
          stopReason: step.stopReason,
        });
        return;
      case "tool_call": {
        const toolCallId = newToolCallId();
        const envelope = this.corr.envelope();
        this.corr.rememberToolCall(toolCallId, envelope.eventId as EventId);
        this.emit({
          ...envelope,
          kind: "tool_call",
          toolCallId,
          tool: step.tool,
          args: redactArgs(step.args),
        });
        // Stash the most recent tool-call id so a subsequent `tool_result`
        // step can link to it without the caller specifying it explicitly.
        this.lastToolCallId = toolCallId;
        return;
      }
      case "tool_result": {
        if (!this.lastToolCallId) {
          throw new Error(
            "EchoHandle: tool_result step emitted without a prior tool_call step in the same script",
          );
        }
        const parent = this.corr.parentForToolResult(this.lastToolCallId);
        this.emit({
          ...this.corr.envelope({ parentEventId: parent }),
          kind: "tool_result",
          toolCallId: this.lastToolCallId,
          ok: step.ok,
          summary: redact(step.summaryText),
          bytes: step.bytes,
        });
        return;
      }
      case "patch_applied":
        this.emit({
          ...this.corr.envelope(),
          kind: "patch_applied",
          files: [...step.files],
          stats: { add: step.add, del: step.del },
        });
        return;
      case "permission_request": {
        // Best-effort correlate to the most recent tool call; if we haven't
        // seen one in this turn, mint a synthetic tool-call id so the schema
        // still validates (field is required).
        const toolCallId = this.lastToolCallId ?? newToolCallId();
        this.emit({
          ...this.corr.envelope(),
          kind: "permission_request",
          toolCallId,
          decision: step.decision,
        });
        return;
      }
      case "usage":
        this.emit({
          ...this.corr.envelope(),
          kind: "usage",
          model: this.currentModel,
          tokens: { input: step.input, output: step.output },
          cache: { hits: step.cacheHits, misses: step.cacheMisses },
        });
        return;
      case "cost":
        this.emit({
          ...this.corr.envelope(),
          kind: "cost",
          usd: step.usd,
          // The capability manifest declares `costReporting: "computed"`;
          // the contract suite asserts the resulting `confidence` is
          // "estimate". We carry the step-declared confidence through to
          // keep the echo adapter faithful to whatever script chose it.
          confidence: step.confidence,
          source: "computed",
        });
        return;
      case "error":
        this.emit({
          ...this.corr.envelope(),
          kind: "error",
          fatal: step.fatal,
          errorCode: step.errorCode,
          message: redact(step.message),
          retriable: step.retriable,
        });
        return;
      case "turn_end":
        this.emit({
          ...this.corr.envelope(),
          kind: "turn_end",
          stopReason: step.stopReason,
          durationMs: step.durationMs,
        });
        return;
      case "park":
        // Handled in `walk()`; unreachable here.
        return;
    }
  }

  private lastToolCallId: ToolCallId | null = null;

  private emit(raw: AgentEvent): void {
    // Validate before enqueue. Schema drift in `@shamu/shared/events` trips
    // the contract suite loudly rather than silently emitting a bad event.
    const ev = validateEvent(raw);
    this.lastEventAt = ev.tsWall;
    this.queue.push(ev);
  }

  async interrupt(reason?: string): Promise<void> {
    if (this.closed) return;
    // No active turn? Nothing to interrupt; emit a no-op interrupt event
    // inside a micro-turn so the contract suite still sees the event.
    if (!this.activeTurn) {
      this.corr.startTurn();
      this.emit({
        ...this.corr.envelope(),
        kind: "interrupt",
        requestedBy: "user",
        delivered: false,
      });
      this.corr.endTurn();
      return;
    }
    // Emit interrupt inside the current turn, then a synthetic turn_end so
    // the consumer's `for await` loop exits promptly.
    this.emit({
      ...this.corr.envelope(),
      kind: "interrupt",
      requestedBy: "user",
      delivered: true,
    });
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
      usd: 0,
      confidence: "estimate",
      source: "computed",
    });
    this.emit({
      ...this.corr.envelope(),
      kind: "turn_end",
      stopReason: reason ?? "interrupted",
      durationMs: 1,
    });
    this.corr.endTurn();
    this.activeTurn = null;
  }

  async setModel(model: string): Promise<void> {
    if (typeof model !== "string" || model.length === 0) {
      throw new Error("EchoHandle.setModel: model must be a non-empty string");
    }
    this.currentModel = model;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!ECHO_CAPABILITIES.permissionModes.includes(mode)) {
      throw new Error(`EchoHandle.setPermissionMode: ${mode} not declared in capabilities`);
    }
    // Echo adapter doesn't actually enforce permission modes — the check
    // above is what matters for the contract's `setPermissionMode` scenario.
  }

  async shutdown(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Emit a best-effort `session_end`. We may or may not have an active
    // turn; start a fresh one so the envelope call succeeds.
    try {
      this.corr.startTurn();
      this.emit({
        ...this.corr.envelope(),
        kind: "session_end",
        reason,
      });
      this.corr.endTurn();
    } catch {
      // If correlation state is wedged for any reason, skip the event and
      // still close the queue — the iterable completing is the contract.
    }
    this.activeTurn = null;
    this.queue.close();
  }
}

/**
 * The adapter. One instance per process is fine — `spawn()` and `resume()`
 * each create a fresh `EchoHandle`.
 */
export class EchoAdapter implements AgentAdapter {
  public readonly vendor: string;
  public readonly capabilities: Readonly<Capabilities> = ECHO_CAPABILITIES;

  private readonly clock: MonotonicClock | undefined;
  private readonly newEventIdFactory: (() => EventId) | undefined;
  private readonly redactor: Redactor;

  constructor(options: EchoAdapterOptions = {}) {
    this.vendor = options.vendor ?? "echo";
    this.clock = options.clock;
    this.newEventIdFactory = options.newEventId;
    this.redactor = options.redactor ?? new Redactor();
  }

  async spawn(opts: SpawnOpts): Promise<AgentHandle> {
    return new EchoHandle(
      null,
      this.vendor,
      opts,
      this.clock,
      this.newEventIdFactory,
      this.redactor,
    );
  }

  async resume(sessionId: SessionId, opts: SpawnOpts): Promise<AgentHandle> {
    return new EchoHandle(
      sessionId,
      this.vendor,
      opts,
      this.clock,
      this.newEventIdFactory,
      this.redactor,
    );
  }
}
