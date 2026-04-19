/**
 * Project Gemini ACP events into `AgentEvent`s.
 *
 * ACP is vendor-neutral, so the `session/update` kinds + shapes Gemini
 * emits match the ones Cursor emits. The projection code here is a near-
 * duplicate of `@shamu/adapter-cursor/src/projection.ts`; the only place
 * we diverge is the inline comment noting Gemini-specific gotchas (e.g.
 * the stdout-corruption issue, which is surfaced BY THE CLIENT as an
 * `AcpProtocolError` and handled in `handle.ts` — the projector never sees
 * malformed frames because `@shamu/protocol-acp` drops them before fanout).
 *
 * Kinds projected today (from the ACP spec + `geminicli.com/docs/cli/acp-mode/`):
 *
 * - `user_message_chunk`       — ignored (echo of the user's input)
 * - `agent_message_chunk`      → `assistant_delta`
 * - `agent_thought_chunk`      → `reasoning`
 * - `tool_call`                → `tool_call`
 * - `tool_call_update`         → `tool_result` once the status reaches
 *                                 `completed` or `failed`
 * - `plan`                     → `reasoning`
 * - `current_mode_update`      — ignored (mode change; shamu owns modes)
 *
 * Terminal signals:
 *
 * - The ACP `session/prompt` RESULT carries `stopReason` + `usage`; the
 *   handle emits `usage` + `cost` + `turn_end` at that point. The
 *   projector does NOT emit `turn_end`.
 *
 * Unknown `sessionUpdate` kinds emerge as `error` events with
 * `errorCode: "unknown_update_kind"` and `retriable: false`. We prefer
 * loud-noise over silent-drop so spec drift is visible in CI.
 *
 * ### Shared-helper followup
 *
 * This module is structurally identical to Cursor's projector modulo
 * doc comments. A follow-up (flagged in the Phase 7.C handoff) should
 * hoist the projection into `@shamu/adapters-base` (or a lower-level
 * helper that `@shamu/protocol-acp` can expose without inverting the
 * dependency on `@shamu/adapters-base`) so both adapters consume one
 * copy. Left duplicated here to avoid perturbing the already-landed
 * Cursor adapter in a track scoped to Gemini delivery.
 */

import type { AgentEvent, CorrelationState } from "@shamu/adapters-base";
import type { AcpSessionUpdate } from "@shamu/protocol-acp";
import { type EventId, newToolCallId, type SessionId, type ToolCallId } from "@shamu/shared/ids";

export interface ProjectionState {
  sessionStartEmitted: boolean;
  turnOpen: boolean;
  readonly toolCallIds: Map<string, ToolCallId>;
  readonly toolCallParents: Map<string, EventId>;
  readonly toolCallsEmitted: Set<string>;
  readonly toolResultsEmitted: Set<string>;
  boundSessionId: SessionId | null;
}

export function createProjectionState(): ProjectionState {
  return {
    sessionStartEmitted: false,
    turnOpen: false,
    toolCallIds: new Map(),
    toolCallParents: new Map(),
    toolCallsEmitted: new Set(),
    toolResultsEmitted: new Set(),
    boundSessionId: null,
  };
}

export interface ProjectionHooks {
  /** Returns the model id to stamp on `usage` events. */
  readonly modelProvider?: () => string;
  /** Deterministic `ToolCallId` factory for snapshot tests. */
  readonly newToolCallId?: () => ToolCallId;
  /** Invoked when the vendor sessionId is first observed. */
  readonly onSessionBound?: (sessionId: SessionId) => void;
}

export interface ProjectionContext {
  readonly corr: CorrelationState;
  readonly state: ProjectionState;
  readonly sessionSource: "spawn" | "resume" | "fork";
  /** The vendor session id we bound at spawn / resume. */
  readonly targetSessionId: string | null;
  readonly hooks?: ProjectionHooks;
}

/**
 * Project a single ACP `session/update` notification. Returns zero or more
 * `AgentEvent`s. Pure function — the caller (`GeminiHandle`) enqueues them.
 *
 * Events whose `sessionId` doesn't match our bound session are silently
 * dropped (defensive; the transport is session-scoped already via
 * `session/new`, but cross-contamination is cheap to guard against).
 */
export function projectGeminiEvent(ev: AcpSessionUpdate, ctx: ProjectionContext): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (!matchesSession(ev.sessionId, ctx)) return out;
  bindSessionIfNeeded(ev.sessionId, ctx);
  openTurnIfNeeded(ctx);

  const upd = ev.update;
  const kind = String(upd.sessionUpdate ?? "");

  switch (kind) {
    case "user_message_chunk":
    case "current_mode_update":
      return out;

    case "agent_message_chunk": {
      const text = extractTextFromContent(upd.content);
      if (text.length > 0) {
        out.push({
          ...ctx.corr.envelope(),
          kind: "assistant_delta",
          text,
        });
      }
      return out;
    }

    case "agent_thought_chunk": {
      const text = extractTextFromContent(upd.content);
      if (text.length > 0) {
        out.push({
          ...ctx.corr.envelope(),
          kind: "reasoning",
          text,
        });
      }
      return out;
    }

    case "plan": {
      const text = extractPlanText(upd);
      if (text.length > 0) {
        out.push({
          ...ctx.corr.envelope(),
          kind: "reasoning",
          text,
        });
      }
      return out;
    }

    case "tool_call": {
      const callId = getString(upd, "toolCallId") ?? getString(upd, "id");
      const toolName = getString(upd, "title") ?? getString(upd, "kind") ?? "unknown_tool";
      if (!callId) return out;
      if (ctx.state.toolCallsEmitted.has(callId)) return out;
      const toolCallId =
        ctx.state.toolCallIds.get(callId) ??
        (ctx.hooks?.newToolCallId ? ctx.hooks.newToolCallId() : newToolCallId());
      ctx.state.toolCallIds.set(callId, toolCallId);
      const envelope = ctx.corr.envelope();
      const eventId = envelope.eventId as EventId;
      ctx.state.toolCallParents.set(callId, eventId);
      ctx.corr.rememberToolCall(toolCallId, eventId);
      out.push({
        ...envelope,
        kind: "tool_call",
        toolCallId,
        tool: toolName,
        args: (upd.rawInput as Record<string, unknown>) ?? {},
      });
      ctx.state.toolCallsEmitted.add(callId);
      const status = getString(upd, "status");
      if (status === "completed" || status === "failed") {
        maybeEmitToolResult(callId, status, upd, ctx, out);
      }
      return out;
    }

    case "tool_call_update": {
      const callId = getString(upd, "toolCallId") ?? getString(upd, "id");
      if (!callId) return out;
      const status = getString(upd, "status") ?? "";
      if (status === "completed" || status === "failed") {
        maybeEmitToolResult(callId, status, upd, ctx, out);
      }
      return out;
    }

    default: {
      out.push({
        ...ctx.corr.envelope(),
        kind: "error",
        fatal: false,
        errorCode: "unknown_update_kind",
        message: `Gemini ACP session/update kind not recognized: ${JSON.stringify(kind)}`,
        retriable: false,
      });
      return out;
    }
  }
}

function maybeEmitToolResult(
  callId: string,
  status: string,
  upd: AcpSessionUpdate["update"],
  ctx: ProjectionContext,
  out: AgentEvent[],
): void {
  if (ctx.state.toolResultsEmitted.has(callId)) return;
  const toolCallId =
    ctx.state.toolCallIds.get(callId) ??
    (ctx.hooks?.newToolCallId ? ctx.hooks.newToolCallId() : newToolCallId());
  ctx.state.toolCallIds.set(callId, toolCallId);
  const parent = ctx.state.toolCallParents.get(callId) ?? null;
  const ok = status === "completed";
  const summary = extractToolSummary(upd);
  out.push({
    ...ctx.corr.envelope({ parentEventId: parent }),
    kind: "tool_result",
    toolCallId,
    ok,
    summary,
    bytes: summary.length,
  });
  ctx.state.toolResultsEmitted.add(callId);
}

// ---- helpers -----------------------------------------------------------

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || typeof content !== "object") return "";
  const obj = content as Record<string, unknown>;
  if (typeof obj.text === "string") return obj.text;
  if (obj.type === "text" && typeof obj.text === "string") return obj.text;
  if (Array.isArray(obj.content)) {
    const parts: string[] = [];
    for (const entry of obj.content) {
      if (entry && typeof entry === "object") {
        const t = (entry as { text?: unknown }).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.join("");
  }
  return "";
}

function extractPlanText(upd: AcpSessionUpdate["update"]): string {
  const entries = (upd as { entries?: unknown }).entries;
  if (Array.isArray(entries)) {
    const lines: string[] = [];
    for (const e of entries) {
      if (e && typeof e === "object") {
        const content = (e as { content?: unknown }).content;
        const t = extractTextFromContent(content);
        if (t.length > 0) lines.push(t);
      }
    }
    return lines.join("\n");
  }
  const content = (upd as { content?: unknown }).content;
  return extractTextFromContent(content);
}

function extractToolSummary(upd: AcpSessionUpdate["update"]): string {
  const content = (upd as { content?: unknown }).content;
  const text = extractTextFromContent(content);
  if (text.length > 0) return text;
  const result = (upd as { result?: unknown }).result;
  if (typeof result === "string") return result;
  if (result !== null && typeof result === "object") {
    const innerText = extractTextFromContent(result);
    if (innerText.length > 0) return innerText;
  }
  const error = (upd as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error !== null && typeof error === "object") {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return "";
}

function getString(obj: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function matchesSession(vendorId: string | undefined, ctx: ProjectionContext): boolean {
  if (!vendorId) return true;
  if (!ctx.targetSessionId) return true;
  return vendorId === ctx.targetSessionId;
}

function bindSessionIfNeeded(vendorId: string, ctx: ProjectionContext): void {
  if (ctx.state.boundSessionId) return;
  const bound = vendorId as SessionId;
  ctx.state.boundSessionId = bound;
  ctx.corr.bindSession(bound);
  ctx.hooks?.onSessionBound?.(bound);
}

function openTurnIfNeeded(ctx: ProjectionContext): void {
  if (ctx.state.turnOpen) return;
  ctx.corr.startTurn();
  ctx.state.turnOpen = true;
}
