/**
 * `AmpHandle` — the live `AgentHandle` for an Amp run.
 *
 * Responsibilities:
 *
 * 1. Drain the driver's `readLines()` stream, projecting each JSONL line
 *    through `projectAmpLine` into `AgentEvent`s. Malformed lines surface
 *    as non-fatal `error` events (amp-gemini-style defense).
 * 2. Apply `decideAmpPermission` to `tool_call` events BEFORE surfacing to
 *    the consumer (G4/G5). Amp dispatches server-side so this is advisory
 *    for downstream consumers — a denial still emits `error` and attempts
 *    to end the current turn by closing stdin. Open question (logged as
 *    followup): whether amp has an in-stream cancel message we should
 *    prefer over closing stdin.
 * 3. Run the redactor on every emitted event (G1).
 * 4. On `send()`, write `{"type":"user","message":{"role":"user","content":
 *    [{"type":"text","text":"..."}]}}` as a single JSONL line to amp's
 *    stdin. Long-lived — stdin stays open between turns.
 * 5. 10-min `promptTimeoutMs` watchdog per turn (configurable via
 *    `vendorOpts.promptTimeoutMs`). On expiry: close stdin, force `turn_end`.
 * 6. `interrupt(reason)` — Amp's JSONL spec as of 2026-04-18 does not
 *    document an in-stream cancel message. We adopt the conservative
 *    approach: close stdin and force the current turn to end synthetically.
 *    The subprocess then exits after its current tool drains; the handle's
 *    consumer sees `turn_end` either from a real `{type:"result"}` or from
 *    our synthetic fallback.
 * 7. `shutdown(reason)` — close driver first (which closes stdin, waits
 *    for amp to drain, then SIGTERM/SIGKILL if necessary), then close queue.
 *
 * Concurrency: one in-flight turn per handle. `send()` while a turn is
 * active throws — the supervisor is responsible for serializing.
 *
 * ### stdin JSON shape for user turns (research gap)
 *
 * The exact schema amp expects for `--stream-json-input` isn't fully
 * documented at `ampcode.com/news/streaming-json` (as of 2026-04-18). We
 * send an Anthropic-message-shaped object since amp's output lines already
 * use that shape for assistant/user/tool_use blocks:
 *
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 *
 * If the live-test feedback loop reveals amp wants a simpler shape
 * (`{"text":"..."}`), the `formatUserTurn` helper is the single edit site.
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
import type { EventId, RunId, SessionId, ToolCallId, TurnId } from "@shamu/shared/ids";
import { Redactor } from "@shamu/shared/redactor";
import type { AmpDriver } from "./driver.ts";
import { decideAmpPermission, type PermissionHandlerOptions } from "./permission-handler.ts";
import {
  createProjectionState,
  type ProjectionContext,
  type ProjectionHooks,
  type ProjectionState,
  projectAmpLine,
} from "./projection.ts";

const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

/** Minimal single-consumer event queue, mirroring the OpenCode pattern. */
class AmpEventQueue {
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

export interface AmpHandleOptions {
  readonly driver: AmpDriver;
  readonly opts: SpawnOpts;
  readonly vendor: string;
  readonly capabilities: Capabilities;
  readonly vendorSessionId: SessionId | null;
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

/**
 * Format a user turn into the JSONL line amp expects on stdin. Exported for
 * tests so alternative shapes can be validated without rebuilding a handle.
 */
export function formatUserTurn(text: string): string {
  const payload = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  };
  return JSON.stringify(payload);
}

export class AmpHandle implements AgentHandle {
  public readonly runId: RunId;
  private _sessionId: SessionId | null;
  private readonly driver: AmpDriver;
  private readonly corr: CorrelationState;
  private readonly queue = new AmpEventQueue();
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
  private stdoutDone: Promise<void>;
  private stderrDone: Promise<void>;

  constructor(options: AmpHandleOptions) {
    // G8 — runId is orchestrator-owned.
    if (!options.opts.runId) {
      throw new Error("AmpHandle: opts.runId is required (G8)");
    }
    this.runId = options.opts.runId;
    this._sessionId = options.vendorSessionId;
    this.driver = options.driver;
    this.capabilities = options.capabilities;
    this.redactor = options.redactor ?? new Redactor();
    this.currentModel = options.opts.model ?? "amp-default";
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
    // When resuming, seed the projector's `boundSessionId` so an echo of the
    // session id from amp's first `{type:"system"}` message doesn't rebind
    // and emit a divergent sessionId.
    if (this._sessionId) {
      this.projState.boundSessionId = this._sessionId;
    }
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

    // Kick off stdout + stderr drainers. Fire-and-forget; unhandled rejections
    // land as `error` events if the handle's still open.
    this.stdoutDone = this.consumeStdout().catch((err) => {
      if (this.closed) return;
      this.emitSafely({
        ...this.safeEnvelope(),
        kind: "error",
        fatal: true,
        errorCode: "amp_stdout_failure",
        message: this.redactor.redact((err as Error)?.message ?? String(err)),
        retriable: false,
      });
    });
    this.stderrDone = this.consumeStderr().catch(() => {
      // Stderr is diagnostic; swallow on error.
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
    if (this.closed) throw new Error("AmpHandle: send() after shutdown()");
    if (this.turnActive) {
      throw new Error("AmpHandle: send() while a turn is already active");
    }
    this.turnActive = true;
    this.armWatchdog();

    const redactedText = this.redactor.redact(message.text);
    const line = formatUserTurn(redactedText);
    try {
      await this.driver.writeLine(line);
    } catch (cause) {
      if (!this.closed) {
        this.emitSafely({
          ...this.safeEnvelope(),
          kind: "error",
          fatal: true,
          errorCode: "amp_stdin_failed",
          message: this.redactor.redact((cause as Error)?.message ?? String(cause)),
          retriable: false,
        });
        this.forceTurnEnd("stdin_error");
      }
      return;
    }
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
    // No documented in-stream cancel on amp's JSONL surface as of 2026-04-18.
    // Closing stdin asks amp to finish the current turn and exit. The driver's
    // close() chain (called from shutdown) escalates to SIGTERM if needed.
    try {
      await this.driver.closeStdin();
    } catch {
      // best-effort
    }
    this.forceTurnEnd(reason ?? "interrupted");
  }

  async setModel(model: string): Promise<void> {
    if (typeof model !== "string" || model.length === 0) {
      throw new Error("AmpHandle.setModel: model must be a non-empty string");
    }
    // Amp's CLI selects model at spawn time (`amp -x --model <...>`). Mid-run
    // switching isn't documented; we stash the value for `usage` stamping.
    // A supervisor wanting a different model should respawn on a fresh
    // handle with `opts.model = ...`.
    this.currentModel = model;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.capabilities.permissionModes.includes(mode)) {
      throw new Error(`AmpHandle.setPermissionMode: ${mode} not declared in capabilities`);
    }
    // Amp declares only "default" today (capabilities.json). The call is
    // accepted as a no-op to keep the contract surface consistent.
  }

  async shutdown(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    // Emit session_end before the queue closes.
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
    // Reap driver FIRST — closing stdin unblocks amp, and waiting for the
    // stdout drainer to complete ensures any trailing lines land in the queue.
    try {
      await this.driver.close();
    } catch {
      // best-effort
    }
    try {
      await this.stdoutDone;
    } catch {
      // ignore
    }
    try {
      await this.stderrDone;
    } catch {
      // ignore
    }
    this.queue.close();
  }

  // ---- internals --------------------------------------------------------

  private async consumeStdout(): Promise<void> {
    for await (const line of this.driver.readLines()) {
      if (this.closed) break;
      this.handleLine(line);
    }
  }

  private async consumeStderr(): Promise<void> {
    for await (const _chunk of this.driver.readStderr()) {
      if (this.closed) break;
      // Amp's stderr carries diagnostic output (license notice, update
      // checks, etc.). Not surfaced as events today; a future followup may
      // route it into `stdout`/`stderr` AgentEvents gated by a verbose flag.
    }
  }

  private handleLine(line: string): void {
    const ctx: ProjectionContext = {
      corr: this.corr,
      state: this.projState,
      sessionSource: this.sessionSource,
      hooks: this.projHooks,
    };
    const projected = projectAmpLine(line, ctx);
    for (const raw of projected) {
      // G4/G5 gate on tool_call events BEFORE surfacing to the consumer.
      // Amp has already dispatched server-side by the time we see the
      // tool_use block; this gate is advisory (prevents downstream flow
      // consumers from acting on a tool that violates scope). Document
      // this nuance in the contract-suite notes.
      if (raw.kind === "tool_call") {
        const decision = decideAmpPermission(
          { tool: raw.tool, ...(isRecord(raw.args) ? { input: raw.args } : {}) },
          this.permissionOpts,
        );
        if (decision && decision.kind === "denied") {
          // Emit the tool_call so the consumer sees the vendor's intent,
          // then emit the error, then try to cancel the turn.
          this.emit(raw);
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
          // Close stdin so amp drains + exits; synthetic turn_end ensures
          // the consumer's for-await advances even if amp's `{type:"result"}`
          // doesn't land.
          void this.driver.closeStdin().catch(() => {});
          this.forceTurnEnd("path_scope_violation");
          return;
        }
      }
      this.emit(raw);
    }
    // Turn-end trigger: our projector emits `turn_end` on `{type:"result"}`.
    // When projected events include a turn_end, mark turnActive false +
    // disarm watchdog.
    for (const raw of projected) {
      if (raw.kind === "turn_end") {
        this.turnActive = false;
        if (this.watchdogTimer) {
          clearTimeout(this.watchdogTimer);
          this.watchdogTimer = null;
        }
        break;
      }
    }
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
      // Close stdin to ask amp to finish + force turn_end so the consumer
      // advances. The next `send()` will fail with `amp_stdin_failed`
      // because stdin is closed — that's the correct behavior: the handle
      // is dead after a watchdog timeout.
      void this.driver.closeStdin().catch(() => {});
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
