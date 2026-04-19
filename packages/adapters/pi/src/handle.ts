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
 *
 * ### Shared harness
 *
 * Event queue, redactor, watchdog, shutdown sequence, envelope threading,
 * and setPermissionMode defaults live in `AdapterHandleBase`
 * (`@shamu/adapters-base/harness`). Shared with Cursor/Gemini/Amp.
 */

import {
  AdapterHandleBase,
  type AdapterHandleBaseOptions,
  type Capabilities,
  type MonotonicClock,
  type SpawnOpts,
  type UserTurn,
} from "@shamu/adapters-base";
import {
  type EventId,
  newToolCallId as newToolCallIdDefault,
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

export class PiHandle extends AdapterHandleBase<ProjectionState> {
  private readonly driver: PiDriver;
  private readonly permissionOpts: PermissionHandlerOptions;
  private readonly projHooks: ProjectionHooks;
  private readonly unsubscribeEvent: () => void;
  private readonly unsubscribeProtocolError: () => void;

  constructor(options: PiHandleOptions) {
    const projState = createProjectionState();
    // Pi emits `session_start` synthetically before its `agent_start`; the
    // projector's guard suppresses a duplicate once the async event lands.
    projState.sessionStartEmitted = true;

    const baseOptions: AdapterHandleBaseOptions<ProjectionState> = {
      runId: options.opts.runId,
      initialSessionId: options.vendorSessionId,
      vendor: options.vendor,
      logLabel: "PiHandle",
      capabilities: options.capabilities,
      projState,
      sessionSource: options.sessionSource,
      redactor: options.redactor ?? new Redactor(),
      initialModel: options.opts.model ?? "pi-default",
      promptTimeoutMs: options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      clock: options.clock,
      newEventId: options.newEventId,
      newTurnId: options.newTurnId,
    };
    super(baseOptions);
    this.driver = options.driver;

    this.projHooks = {
      modelProvider: () => this.currentModel,
      ...(options.newToolCallId ? { newToolCallId: options.newToolCallId } : {}),
      onSessionBound: (sid) => {
        this.bindSessionId(sid);
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
    this.emitSafely({
      ...this.safeEnvelope(),
      kind: "session_start",
      source: this.sessionSource,
    });
  }

  async send(message: UserTurn): Promise<void> {
    if (this.closed) throw new Error("PiHandle: send() after shutdown()");
    if (this.turnActive) {
      throw new Error("PiHandle: send() while a turn is already active");
    }
    this.beginTurn();

    const redactedText = this.redactor.redact(message.text);

    // Fire-and-handle-async — the `prompt` response only ACKs receipt; the
    // rich per-event content arrives on the async stream. We DON'T block
    // `send()` on the response so consumers (and `interrupt()`) can drive
    // the event loop while the turn is live.
    this.watchPromptPromise(
      this.driver.client.sendCommand(
        "prompt",
        { message: redactedText },
        { timeoutMs: this.promptTimeoutMs },
      ),
      {
        // ACK — `turn_end` event drives the actual turn close.
        onResolved: () => {},
        errorCode: "pi_prompt_failed",
      },
    );
  }

  async interrupt(reason?: string): Promise<void> {
    await this.doInterrupt(reason, async () => {
      // best-effort — Pi may reject if no turn is active.
      await this.driver.client.sendCommand("abort", {});
    });
  }

  override async setModel(model: string): Promise<void> {
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

  async shutdown(reason: string): Promise<void> {
    await this.runSharedShutdown(reason, {
      closeDriver: () => this.driver.close(),
      unsubscribe: [this.unsubscribeEvent, this.unsubscribeProtocolError],
    });
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
      this.watchdog.clear();
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

  private runProjector(ev: PiAsyncEvent) {
    const ctx: ProjectionContext = {
      corr: this.corr,
      state: this.projState,
      sessionSource: this.sessionSource,
      targetSessionId: this._sessionId as SessionId,
      hooks: this.projHooks,
    };
    return projectPiEvent(ev as Readonly<Record<string, unknown>>, ctx);
  }

  protected override onWatchdogFire(): void {
    void this.driver.client.sendCommand("abort", {}).catch(() => {});
    this.forceTurnEnd("prompt_watchdog");
  }
}

// Keep the tool-call id factory import alive — re-exported from here so
// tests that want a stable ToolCallId hook can grab the default.
export { newToolCallIdDefault };
