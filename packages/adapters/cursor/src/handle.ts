/**
 * `CursorHandle` — the live `AgentHandle` for a Cursor ACP run.
 *
 * Responsibilities:
 *
 * 1. Own one `AcpClient` per handle. The client delivers:
 *    - `session/update` notifications (via `onSessionUpdate`) → projector
 *    - `session/request_permission` server-initiated requests (via
 *      `onPermissionRequest`) → pre-dispatch G4/G5 gate
 *    - protocol errors (via `onProtocolError`) → non-fatal `error` events
 * 2. Emit `session_start` at spawn/resume time (before the first
 *    notification lands), so consumers always see the ordered envelope.
 * 3. On each `send()`, call `client.prompt({ sessionId, prompt })` and wait
 *    for its result. The result carries `stopReason` + `usage`; the handle
 *    emits `usage` + `cost` + `turn_end` from the result plumbing.
 * 4. Apply `decideCursorPermission` in the `onPermissionRequest` handler.
 *    A denial returns the `deny` `AcpPermissionDecision` to the client so
 *    the server stops dispatching the tool; the handle emits
 *    `permission_request` with `decision: "deny"` + an `error` event.
 * 5. Run the redactor on every emitted event (G1).
 * 6. On `shutdown()`, close the driver FIRST (reaps the subprocess and
 *    unblocks parked awaits), then drain any queued notifications, then
 *    close the queue. Mirrors the OpenCode fix.
 *
 * Concurrency: one in-flight turn per handle. `send()` while a turn is
 * active throws — the supervisor is responsible for serializing.
 *
 * ### session/prompt timeout (configurable)
 *
 * Each `send()` arms a watchdog: if `promptTimeoutMs` elapses without the
 * prompt result resolving, the handle `cancelSession()`s and force-emits
 * `turn_end` with `stopReason: "prompt_watchdog"`. Default 10 minutes —
 * generous so legitimate long-running tasks aren't killed.
 *
 * ### Shared harness
 *
 * Boilerplate (event queue, redactor pipeline, watchdog, shutdown
 * sequence, envelope threading) is owned by `AdapterHandleBase` in
 * `@shamu/adapters-base/harness`. This file retains only the Cursor-
 * specific send/interrupt/setPermissionMode surface.
 */

import {
  AdapterHandleBase,
  type AdapterHandleBaseOptions,
  type Capabilities,
  type MonotonicClock,
  type PermissionMode,
  type SpawnOpts,
  type UserTurn,
} from "@shamu/adapters-base";
import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpPromptResult,
  AcpProtocolError,
  AcpSessionUpdate,
} from "@shamu/protocol-acp";
import {
  type EventId,
  newToolCallId as newToolCallIdDefault,
  type SessionId,
  type ToolCallId,
  type TurnId,
} from "@shamu/shared/ids";
import { Redactor } from "@shamu/shared/redactor";
import type { CursorDriver } from "./driver.ts";
import { type CursorPermissionOptions, decideCursorPermission } from "./permission-handler.ts";
import {
  createProjectionState,
  type ProjectionContext,
  type ProjectionHooks,
  type ProjectionState,
  projectCursorEvent,
} from "./projection.ts";

const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

export interface CursorHandleOptions {
  readonly driver: CursorDriver;
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
  readonly permissionOptionsOverride?: CursorPermissionOptions | undefined;
}

export class CursorHandle extends AdapterHandleBase<ProjectionState> {
  private readonly driver: CursorDriver;
  private readonly permissionOpts: CursorPermissionOptions;
  private readonly projHooks: ProjectionHooks;
  private readonly unsubscribeSessionUpdate: () => void;
  private readonly unsubscribePermission: () => void;
  private readonly unsubscribeProtocolError: () => void;

  constructor(options: CursorHandleOptions) {
    const projState = createProjectionState();
    const baseOptions: AdapterHandleBaseOptions<ProjectionState> = {
      runId: options.opts.runId,
      initialSessionId: options.vendorSessionId,
      vendor: options.vendor,
      logLabel: "CursorHandle",
      capabilities: options.capabilities,
      projState,
      sessionSource: options.sessionSource,
      redactor: options.redactor ?? new Redactor(),
      initialModel: options.opts.model ?? "cursor-default",
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

  async send(message: UserTurn): Promise<void> {
    if (this.closed) throw new Error("CursorHandle: send() after shutdown()");
    if (this.turnActive) {
      throw new Error("CursorHandle: send() while a turn is already active");
    }
    this.beginTurn();

    const redactedText = this.redactor.redact(message.text);
    // `session/prompt` is a JSON-RPC request whose response carries the
    // terminal stopReason + usage, but in ACP the server streams
    // `session/update` notifications during the turn. Don't block `send()`
    // on the response — fire-and-handle-async so consumers (and
    // `interrupt()`) can drive the event loop while the turn is live.
    this.watchPromptPromise(
      this.driver.client.prompt(
        {
          sessionId: this._sessionId as SessionId,
          prompt: [{ type: "text", text: redactedText }],
        },
        { timeoutMs: this.promptTimeoutMs },
      ),
      {
        onResolved: (result) => this.onPromptResult(result),
        errorCode: "cursor_prompt_failed",
      },
    );
  }

  async interrupt(reason?: string): Promise<void> {
    await this.doInterrupt(reason, async () => {
      await this.driver.client.cancelSession(this._sessionId as SessionId);
    });
  }

  override async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.capabilities.permissionModes.includes(mode)) {
      throw new Error(`CursorHandle.setPermissionMode: ${mode} not declared in capabilities`);
    }
    // ACP doesn't expose a mid-session permission-mode setter today. Mode
    // changes land by spawning a fresh handle with the new mode.
  }

  async shutdown(reason: string): Promise<void> {
    await this.runSharedShutdown(reason, {
      closeDriver: () => this.driver.close(),
      unsubscribe: [
        this.unsubscribeSessionUpdate,
        this.unsubscribePermission,
        this.unsubscribeProtocolError,
      ],
    });
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
        errorCode: "cursor_projection_error",
        message: this.redactor.redact((cause as Error)?.message ?? String(cause)),
        retriable: false,
      });
    }
  }

  private async handlePermission(req: AcpPermissionRequest): Promise<AcpPermissionDecision> {
    if (this.closed) {
      return { outcome: "cancelled" };
    }
    // G4/G5 gate evaluated BEFORE the server dispatches the tool.
    const decision = decideCursorPermission(req, this.permissionOpts);

    // Emit a `permission_request` event describing what we decided.
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
        // unknown classification — record as `ask` so downstream consumers
        // can choose a policy. The returned ACP decision is still allow
        // (see permission-handler).
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
    this.watchdog.clear();
  }

  // ---- internal helpers ------------------------------------------------

  private runProjector(ev: AcpSessionUpdate) {
    const ctx: ProjectionContext = {
      corr: this.corr,
      state: this.projState,
      sessionSource: this.sessionSource,
      targetSessionId: this._sessionId as SessionId,
      hooks: this.projHooks,
    };
    return projectCursorEvent(ev, ctx);
  }

  protected override onWatchdogFire(): void {
    void this.driver.client.cancelSession(this._sessionId as SessionId).catch(() => {});
    this.forceTurnEnd("prompt_watchdog");
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
