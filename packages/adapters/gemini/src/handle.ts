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
 * Every other piece of plumbing (event queue, redactor pipeline, watchdog,
 * shutdown-close-driver-first) is owned by `AdapterHandleBase` in
 * `@shamu/adapters-base/harness`. Shared with Cursor/Amp/Pi.
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

export class GeminiHandle extends AdapterHandleBase<ProjectionState> {
  private readonly driver: GeminiDriver;
  private readonly permissionOpts: GeminiPermissionOptions;
  private readonly projHooks: ProjectionHooks;
  private readonly unsubscribeSessionUpdate: () => void;
  private readonly unsubscribePermission: () => void;
  private readonly unsubscribeProtocolError: () => void;

  constructor(options: GeminiHandleOptions) {
    const projState = createProjectionState();
    const baseOptions: AdapterHandleBaseOptions<ProjectionState> = {
      runId: options.opts.runId,
      initialSessionId: options.vendorSessionId,
      vendor: options.vendor,
      logLabel: "GeminiHandle",
      capabilities: options.capabilities,
      projState,
      sessionSource: options.sessionSource,
      redactor: options.redactor ?? new Redactor(),
      initialModel: options.opts.model ?? "gemini-default",
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
    if (this.closed) throw new Error("GeminiHandle: send() after shutdown()");
    if (this.turnActive) {
      throw new Error("GeminiHandle: send() while a turn is already active");
    }
    this.beginTurn();

    const redactedText = this.redactor.redact(message.text);
    // Same fire-and-handle-async pattern as Cursor: let `session/update`
    // notifications drive the event loop while the prompt's promise
    // resolves in the background with the terminal usage + stopReason.
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
        errorCode: "gemini_prompt_failed",
      },
    );
  }

  async interrupt(reason?: string): Promise<void> {
    await this.doInterrupt(reason, async () => {
      await this.driver.client.cancelSession(this._sessionId as SessionId);
    });
  }

  override async setModel(model: string): Promise<void> {
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
    return projectGeminiEvent(ev, ctx);
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
