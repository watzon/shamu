/**
 * `GeminiHandle` — the live `AgentHandle` for a Gemini ACP run.
 *
 * Structurally identical to `CursorHandle` (both speak ACP). The notable
 * deltas vs Cursor are:
 *
 * 1. **`setModel` wires `unstable_setSessionModel`.** Gemini CLI's ACP
 *    surface exposes a per-session model change via the `unstable_`-prefixed
 *    RPC (`unstable_setSessionModel`). The capability manifest does NOT
 *    declare a `setModel` field today (we keep the Capabilities union
 *    conservative), but `handle.setModel(model)` still dispatches to the
 *    RPC so callers who know Gemini is behind the handle can switch
 *    models mid-run. The `unstable_` prefix is a Gemini caveat — the RPC
 *    may be renamed once the method graduates. If the RPC errors (e.g.
 *    the Gemini version doesn't support it yet), we fall back to a local
 *    model-name update + emit a non-fatal warning `error` event.
 *
 * 2. **Protocol-error fanout surfaces malformed JSON-RPC lines.** The
 *    upstream gemini-cli#22647 bug can bleed non-ACP bytes into stdout;
 *    `@shamu/protocol-acp`'s client validates every line via
 *    `decodeFrames` and invokes `onProtocolError` for each unparseable
 *    frame. The handle maps those to non-fatal `error` events with
 *    `errorCode: "acp_protocol"` so the run keeps going.
 *
 * Every other piece of plumbing (EventQueue, redactor, G4/G5 permission
 * gate, watchdog, shutdown-close-driver-first) mirrors `CursorHandle`
 * verbatim. See the followup note in `projection.ts` for the
 * consolidation we should do in a shared helper.
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
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type AcpPromptResult,
  type AcpProtocolError,
  AcpRpcError,
  type AcpSessionUpdate,
} from "@shamu/protocol-acp";
import {
  type EventId,
  newToolCallId as newToolCallIdDefault,
  type RunId,
  type SessionId,
  type ToolCallId,
  type TurnId,
} from "@shamu/shared/ids";
import { Redactor } from "@shamu/shared/redactor";
import type { GeminiDriver } from "./driver.ts";
import { decideGeminiPermission, type GeminiPermissionOptions } from "./permission-handler.ts";
import {
  createProjectionState,
  type ProjectionContext,
  type ProjectionHooks,
  type ProjectionState,
  projectGeminiEvent,
} from "./projection.ts";

const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

/** Minimal single-consumer event queue, mirroring the Cursor pattern. */
class GeminiEventQueue {
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

export interface GeminiHandleOptions {
  readonly driver: GeminiDriver;
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
  readonly permissionOptionsOverride?: GeminiPermissionOptions | undefined;
}

export class GeminiHandle implements AgentHandle {
  public readonly runId: RunId;
  private _sessionId: SessionId;
  private readonly driver: GeminiDriver;
  private readonly corr: CorrelationState;
  private readonly queue = new GeminiEventQueue();
  private readonly redactor: Redactor;
  private readonly capabilities: Capabilities;
  private readonly permissionOpts: GeminiPermissionOptions;
  private readonly projState: ProjectionState;
  private readonly projHooks: ProjectionHooks;
  private readonly sessionSource: "spawn" | "resume" | "fork";
  private readonly promptTimeoutMs: number;

  private currentModel: string;
  private lastEventAt = 0;
  private turnActive = false;
  private closed = false;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribeSessionUpdate: () => void;
  private readonly unsubscribePermission: () => void;
  private readonly unsubscribeProtocolError: () => void;

  constructor(options: GeminiHandleOptions) {
    // G8 — runId is orchestrator-owned.
    if (!options.opts.runId) {
      throw new Error("GeminiHandle: opts.runId is required (G8)");
    }
    this.runId = options.opts.runId;
    this._sessionId = options.vendorSessionId;
    this.driver = options.driver;
    this.capabilities = options.capabilities;
    this.redactor = options.redactor ?? new Redactor();
    this.currentModel = options.opts.model ?? "gemini-default";
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

    // Wire the client event streams.
    const client = this.driver.client;
    this.unsubscribeSessionUpdate = client.onSessionUpdate((ev) => this.handleSessionUpdate(ev));
    this.unsubscribePermission = client.onPermissionRequest((req) => this.handlePermission(req));
    this.unsubscribeProtocolError = client.onProtocolError((err) => this.handleProtocolError(err));

    // Emit `session_start` proactively — the ACP stream won't deliver a
    // session-bound signal on its own once the session is created.
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
    if (this.closed) throw new Error("GeminiHandle: send() after shutdown()");
    if (this.turnActive) {
      throw new Error("GeminiHandle: send() while a turn is already active");
    }
    this.turnActive = true;
    this.armWatchdog();

    const redactedText = this.redactor.redact(message.text);
    // Same fire-and-handle-async pattern as Cursor: let `session/update`
    // notifications drive the event loop while the prompt's promise
    // resolves in the background with the terminal usage + stopReason.
    this.driver.client
      .prompt(
        {
          sessionId: this._sessionId,
          prompt: [{ type: "text", text: redactedText }],
        },
        { timeoutMs: this.promptTimeoutMs },
      )
      .then((result) => {
        if (!this.closed) this.onPromptResult(result);
      })
      .catch((cause) => {
        if (this.closed) return;
        this.emitSafely({
          ...this.safeEnvelope(),
          kind: "error",
          fatal: true,
          errorCode: "gemini_prompt_failed",
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
      await this.driver.client.cancelSession(this._sessionId);
    } catch {
      // best-effort
    }
    this.forceTurnEnd(reason ?? "interrupted");
  }

  async setModel(model: string): Promise<void> {
    if (typeof model !== "string" || model.length === 0) {
      throw new Error("GeminiHandle.setModel: model must be a non-empty string");
    }
    const previousModel = this.currentModel;
    this.currentModel = model;
    if (this.closed) return;
    // Gemini CLI exposes a per-session model change via the
    // `unstable_setSessionModel` RPC. The `unstable_` prefix is a Gemini
    // caveat: the method may be renamed / removed once it graduates. If
    // the RPC fails (Gemini version missing the method, ACP server
    // rejects, etc.), revert to local tracking only and emit a non-fatal
    // warning so the caller sees the fallback — the stamped `usage.model`
    // will still reflect the requested value since we updated
    // `currentModel` eagerly.
    try {
      await this.driver.client.sendRequest(
        "unstable_setSessionModel",
        {
          sessionId: this._sessionId,
          model,
        },
        { timeoutMs: 10_000 },
      );
    } catch (cause) {
      const rpcCode = cause instanceof AcpRpcError ? ` (rpcCode=${cause.rpcCode})` : "";
      this.emitSafely({
        ...this.safeEnvelope(),
        kind: "error",
        fatal: false,
        errorCode: "gemini_set_model_unsupported",
        message: this.redactor.redact(
          `unstable_setSessionModel failed${rpcCode}; model "${model}" applied locally only (previous: "${previousModel}"): ${
            (cause as Error)?.message ?? String(cause)
          }`,
        ),
        retriable: false,
      });
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.capabilities.permissionModes.includes(mode)) {
      throw new Error(`GeminiHandle.setPermissionMode: ${mode} not declared in capabilities`);
    }
    // ACP doesn't expose a mid-session permission-mode setter today. Mode
    // changes land by spawning a fresh handle with the new mode.
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
      // envelope state wedged — queue-close is the contract.
    }
    // Close the driver FIRST — this reaps the subprocess and unblocks any
    // in-flight request promises (they reject with AcpShutdownError).
    try {
      await this.driver.close();
    } catch {
      // best-effort
    }
    // Drop client subscriptions.
    try {
      this.unsubscribeSessionUpdate();
    } catch {
      // ignore
    }
    try {
      this.unsubscribePermission();
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

  // ---- Incoming event plumbing -----------------------------------------

  private handleSessionUpdate(ev: AcpSessionUpdate): void {
    if (this.closed) return;
    try {
      const projected = this.runProjector(ev);
      for (const out of projected) this.emit(out);
    } catch (cause) {
      this.emitSafely({
        ...this.safeEnvelope(),
        kind: "error",
        fatal: false,
        errorCode: "gemini_projection_error",
        message: this.redactor.redact((cause as Error)?.message ?? String(cause)),
        retriable: false,
      });
    }
  }

  private async handlePermission(req: AcpPermissionRequest): Promise<AcpPermissionDecision> {
    if (this.closed) {
      return { outcome: "cancelled" };
    }
    const decision = decideGeminiPermission(req, this.permissionOpts);

    const toolCallId = this.toolCallIdForRequest(req);
    const openEnvelope = this.safeEnvelope();
    try {
      if (decision.kind === "denied") {
        this.emit({
          ...openEnvelope,
          kind: "permission_request",
          toolCallId,
          decision: "deny",
        });
        this.emit({
          ...this.corr.envelope(),
          kind: "error",
          fatal: true,
          errorCode: decision.error.code,
          message: this.redactor.redact(decision.error.message),
          retriable: false,
        });
      } else if (decision.kind === "allowed") {
        this.emit({
          ...openEnvelope,
          kind: "permission_request",
          toolCallId,
          decision: "allow",
        });
      } else {
        this.emit({
          ...openEnvelope,
          kind: "permission_request",
          toolCallId,
          decision: "ask",
        });
      }
    } catch {
      // envelope wedged; drop
    }
    return decision.decision;
  }

  private handleProtocolError(err: AcpProtocolError): void {
    if (this.closed) return;
    // Gemini's upstream stdout-corruption issue (gemini-cli#22647) is
    // handled here: the protocol-acp client catches malformed lines before
    // they reach the projector, and this handler surfaces each as a
    // non-fatal `error` AgentEvent. The run keeps going.
    this.emitSafely({
      ...this.safeEnvelope(),
      kind: "error",
      fatal: false,
      errorCode: "acp_protocol",
      message: this.redactor.redact(err.message),
      retriable: false,
    });
  }

  private onPromptResult(result: AcpPromptResult): void {
    if (this.closed) return;
    const usage = result.usage ?? {};
    const input = pickNumber(usage, ["inputTokens", "input"]) ?? 0;
    const output = pickNumber(usage, ["outputTokens", "output"]) ?? 0;
    const reasoning = pickNumber(usage, ["reasoningTokens", "reasoning"]);
    const cached = pickNumber(usage, ["cachedInputTokens", "cached"]) ?? 0;
    try {
      this.emit({
        ...this.corr.envelope(),
        kind: "usage",
        model: this.currentModel,
        tokens: {
          input,
          output,
          ...(reasoning !== undefined ? { reasoning } : {}),
        },
        cache: {
          hits: cached,
          misses: 0,
        },
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
        stopReason: result.stopReason ?? "end_turn",
        durationMs: 0,
      });
      this.corr.endTurn();
      this.projState.turnOpen = false;
    } catch {
      // envelope wedged
    }
    this.turnActive = false;
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  // ---- internal helpers ------------------------------------------------

  private runProjector(ev: AcpSessionUpdate): AgentEvent[] {
    const ctx: ProjectionContext = {
      corr: this.corr,
      state: this.projState,
      sessionSource: this.sessionSource,
      targetSessionId: this._sessionId,
      hooks: this.projHooks,
    };
    return projectGeminiEvent(ev, ctx);
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
      void this.driver.client.cancelSession(this._sessionId).catch(() => {});
      this.forceTurnEnd("prompt_watchdog");
    }, this.promptTimeoutMs);
  }

  private toolCallIdForRequest(req: AcpPermissionRequest): ToolCallId {
    const vendorId = req.toolCall.toolCallId ?? "";
    const existing = this.projState.toolCallIds.get(vendorId);
    if (existing) return existing;
    const factory = this.projHooks.newToolCallId;
    const minted = factory ? factory() : newToolCallIdDefault();
    if (vendorId) this.projState.toolCallIds.set(vendorId, minted);
    return minted;
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

function pickNumber(
  obj: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}
