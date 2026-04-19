/**
 * `PiHandle` — the live `AgentHandle` for a Pi RPC run.
 *
 * Responsibilities:
 *
 * 1. Own one `PiRpcClient` per handle. The client delivers:
 *    - Async events (via `onEvent`) → projector → event queue
 *    - Protocol errors (via `onProtocolError`) → non-fatal `error` events
 * 2. Emit `session_start` at spawn/resume time (before any async events
 *    arrive) so consumers see an ordered envelope. Pi's `agent_start`
 *    event, if it fires later, is folded via the projector's
 *    `sessionStartEmitted` guard.
 * 3. On each `send()`, issue the `prompt` command with the user's text.
 *    The response is a plain `{success: true}` acknowledgement — per Pi
 *    docs. Per-event content arrives on the async event stream; `turn_end`
 *    closes the turn.
 * 4. Apply `decidePiPermission` to incoming `tool_execution_start` events
 *    BEFORE projecting them. On deny, surface the projected `tool_call`,
 *    emit an `error` with the typed reason, and force-end the turn via
 *    `abort` (Pi's documented turn-kill command).
 * 5. Run the redactor on every emitted event (G1).
 * 6. On `shutdown()`, close the driver FIRST (ends stdin → Pi terminates
 *    → event stream completes), then unsubscribe, then close the queue.
 *
 * Concurrency: one in-flight turn per handle. `send()` while a turn is
 * active throws — the supervisor is responsible for serializing.
 *
 * ### Prompt timeout
 *
 * Each `send()` arms a watchdog: if `promptTimeoutMs` elapses without a
 * `turn_end`, the handle fires the `abort` command and force-emits a
 * `turn_end` with `stopReason: "prompt_watchdog"`. Default 10 minutes.
 */

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
import {
  type EventId,
  newToolCallId as newToolCallIdDefault,
  type RunId,
  type SessionId,
  type ToolCallId,
  type TurnId,
} from "@shamu/shared/ids";
import { Redactor } from "@shamu/shared/redactor";
import type { PiDriver } from "./driver.ts";
import type { PiProtocolError } from "./errors.ts";
import { decidePiPermission, type PermissionHandlerOptions } from "./permission-handler.ts";
import {
  createProjectionState,
  type ProjectionContext,
  type ProjectionHooks,
  type ProjectionState,
  projectPiEvent,
} from "./projection.ts";
import type { PiAsyncEvent } from "./rpc-client.ts";

const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

/** Minimal single-consumer event queue, mirroring the Cursor / OpenCode shape. */
class PiEventQueue {
  private readonly waiters: Array<(v: IteratorResult<AgentEvent>) => void> = [];
  private readonly pending: AgentEvent[] = [];
  private closed = false;

  push(ev: AgentEvent): void {
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

export interface PiHandleOptions {
  readonly driver: PiDriver;
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
  /** Override the permission handler (tests). */
  readonly permissionOptionsOverride?: PermissionHandlerOptions | undefined;
}

export class PiHandle implements AgentHandle {
  public readonly runId: RunId;
  private _sessionId: SessionId;
  private readonly driver: PiDriver;
  private readonly corr: CorrelationState;
  private readonly queue = new PiEventQueue();
  private readonly redactor: Redactor;
  private readonly capabilities: Capabilities;
  private readonly permissionOpts: PermissionHandlerOptions;
  private readonly projState: ProjectionState;
  private readonly projHooks: ProjectionHooks;
  private readonly sessionSource: "spawn" | "resume" | "fork";
  private readonly promptTimeoutMs: number;

  private currentModel: string;
  private lastEventAt = 0;
  private turnActive = false;
  private closed = false;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribeEvent: () => void;
  private readonly unsubscribeProtocolError: () => void;

  constructor(options: PiHandleOptions) {
    // G8 — runId is orchestrator-owned.
    if (!options.opts.runId) {
      throw new Error("PiHandle: opts.runId is required (G8)");
    }
    this.runId = options.opts.runId;
    this._sessionId = options.vendorSessionId;
    this.driver = options.driver;
    this.capabilities = options.capabilities;
    this.redactor = options.redactor ?? new Redactor();
    this.currentModel = options.opts.model ?? "pi-default";
    this.sessionSource = options.sessionSource;
    this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;

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

    const client = this.driver.client;
    this.unsubscribeEvent = client.onEvent((ev) => this.handleAsyncEvent(ev));
    this.unsubscribeProtocolError = client.onProtocolError((err) => this.handleProtocolError(err));

    // Emit `session_start` proactively. If Pi later emits its own
    // `agent_start` the projector's `sessionStartEmitted` guard suppresses
    // a duplicate.
    this.projState.sessionStartEmitted = true;
    this.emitSafely({
      ...this.safeEnvelope(),
      kind: "session_start",
      source: this.sessionSource,
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
    if (this.closed) throw new Error("PiHandle: send() after shutdown()");
    if (this.turnActive) {
      throw new Error("PiHandle: send() while a turn is already active");
    }
    this.turnActive = true;
    this.armWatchdog();

    const redactedText = this.redactor.redact(message.text);

    // Fire-and-handle-async — the `prompt` response only ACKs receipt; the
    // rich per-event content arrives on the async stream. We DON'T block
    // `send()` on the response so consumers (and `interrupt()`) can drive
    // the event loop while the turn is live.
    this.driver.client
      .sendCommand("prompt", { message: redactedText }, { timeoutMs: this.promptTimeoutMs })
      .then(() => {
        // ACK — `turn_end` event drives the actual turn close.
      })
      .catch((cause) => {
        if (this.closed) return;
        this.emitSafely({
          ...this.safeEnvelope(),
          kind: "error",
          fatal: true,
          errorCode: "pi_prompt_failed",
          message: this.redactor.redact((cause as Error)?.message ?? String(cause)),
          retriable: false,
        });
        this.forceTurnEnd("prompt_error");
      });
  }

  async interrupt(reason?: string): Promise<void> {
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
      this.emit({
        ...this.corr.envelope(),
        kind: "interrupt",
        requestedBy: "user",
        delivered: false,
      });
    }
    try {
      await this.driver.client.sendCommand("abort", {});
    } catch {
      // best-effort — Pi may reject if no turn is active.
    }
    this.forceTurnEnd(reason ?? "interrupted");
  }

  async setModel(model: string): Promise<void> {
    if (typeof model !== "string" || model.length === 0) {
      throw new Error("PiHandle.setModel: model must be a non-empty string");
    }
    // Pi supports `set_model` RPC to change the active provider/model. We
    // fire-and-await the command and stash the value for `usage` stamping.
    // Errors surface as `pi_set_model_failed`.
    try {
      await this.driver.client.sendCommand("set_model", { model });
      this.currentModel = model;
    } catch (cause) {
      this.emitSafely({
        ...this.safeEnvelope(),
        kind: "error",
        fatal: false,
        errorCode: "pi_set_model_failed",
        message: this.redactor.redact((cause as Error)?.message ?? String(cause)),
        retriable: false,
      });
      throw cause;
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.capabilities.permissionModes.includes(mode)) {
      throw new Error(`PiHandle.setPermissionMode: ${mode} not declared in capabilities`);
    }
    // Pi's RPC surface does not expose a mid-session permission-mode setter.
    // Mode changes land by spawning a fresh handle with the new mode.
  }

  async shutdown(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    // session_end envelope first — consumers should see it before the
    // queue closes.
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
      // envelope wedged — queue-close is the contract.
    }
    // Close the driver FIRST — ending stdin signals Pi to shut down; the
    // event stream completes naturally afterwards.
    try {
      await this.driver.close();
    } catch {
      // best-effort
    }
    try {
      this.unsubscribeEvent();
    } catch {
      // ignore
    }
    try {
      this.unsubscribeProtocolError();
    } catch {
      // ignore
    }
    this.queue.close();
  }

  // ---- Incoming-event plumbing ----------------------------------------

  private handleAsyncEvent(ev: PiAsyncEvent): void {
    if (this.closed) return;

    // G4/G5 gate: run path-scope + shell-gate on every tool_execution_start
    // BEFORE projecting the tool_call. A denial emits the projected
    // tool_call (so consumers see what was attempted) + an error and force-
    // ends the turn.
    if (ev.type === "tool_execution_start") {
      const toolName =
        typeof ev.toolName === "string"
          ? (ev.toolName as string)
          : typeof ev.name === "string"
            ? (ev.name as string)
            : "";
      const args = (ev.args ?? ev.input) as Record<string, unknown> | undefined;
      const decision = decidePiPermission(
        { tool: toolName, ...(args ? { input: args } : {}) },
        this.permissionOpts,
      );
      if (decision && decision.kind === "denied") {
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
          // envelope wedged
        }
        // Pi exposes `abort` as a turn-kill RPC — fire it best-effort.
        void this.driver.client.sendCommand("abort", {}).catch(() => {});
        this.forceTurnEnd("path_scope_violation");
        return;
      }
    }

    try {
      const projected = this.runProjector(ev);
      for (const out of projected) this.emit(out);
    } catch (cause) {
      this.emitSafely({
        ...this.safeEnvelope(),
        kind: "error",
        fatal: false,
        errorCode: "pi_projection_error",
        message: this.redactor.redact((cause as Error)?.message ?? String(cause)),
        retriable: false,
      });
      return;
    }

    // Turn-end trigger: on `turn_end` flip turnActive off + disarm watchdog.
    if (ev.type === "turn_end") {
      this.turnActive = false;
      if (this.watchdogTimer) {
        clearTimeout(this.watchdogTimer);
        this.watchdogTimer = null;
      }
    }
  }

  private handleProtocolError(err: PiProtocolError): void {
    if (this.closed) return;
    this.emitSafely({
      ...this.safeEnvelope(),
      kind: "error",
      fatal: false,
      errorCode: "pi_protocol",
      message: this.redactor.redact(err.message),
      retriable: false,
    });
  }

  // ---- Internal helpers ------------------------------------------------

  private runProjector(ev: PiAsyncEvent): AgentEvent[] {
    const ctx: ProjectionContext = {
      corr: this.corr,
      state: this.projState,
      sessionSource: this.sessionSource,
      targetSessionId: this._sessionId,
      hooks: this.projHooks,
    };
    return projectPiEvent(ev as Readonly<Record<string, unknown>>, ctx);
  }

  private emit(raw: AgentEvent): void {
    const redacted = this.redactEvent(raw);
    const validated = validateEvent(redacted);
    this.lastEventAt = validated.tsWall;
    this.queue.push(validated);
  }

  private emitSafely(raw: AgentEvent): void {
    try {
      this.emit(raw);
    } catch {
      // validation/envelope wedged; swallow so shutdown completes.
    }
  }

  private safeEnvelope() {
    if (!this.projState.turnOpen) {
      this.corr.startTurn();
      this.projState.turnOpen = true;
    }
    return this.corr.envelope();
  }

  private forceTurnEnd(stopReason: string): void {
    if (!this.projState.turnOpen) {
      this.turnActive = false;
      if (this.watchdogTimer) {
        clearTimeout(this.watchdogTimer);
        this.watchdogTimer = null;
      }
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
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private armWatchdog(): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (this.closed || !this.turnActive) return;
      void this.driver.client.sendCommand("abort", {}).catch(() => {});
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

// Keep the tool-call id factory import alive — re-exported from here so
// tests that want a stable ToolCallId hook can grab the default.
export { newToolCallIdDefault };
