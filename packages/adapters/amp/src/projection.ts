/**
 * Project Amp JSONL messages → `AgentEvent[]`.
 *
 * Amp's stream-JSON surface emits one JSON object per line over stdout.
 * The message dictionary (per `ampcode.com/news/streaming-json` + the
 * Phase 7 spike writeup):
 *
 * - `{type:"system", session_id, model, ...}` → `session_start`
 * - `{type:"assistant", message:{content:[...]}}` → per-block projection:
 *     text blocks      → `assistant_delta` (interim) / `assistant_message` (final)
 *     tool_use blocks  → `tool_call` (emit once per unique tool_use id)
 *     thinking/reasoning blocks → `reasoning`
 * - `{type:"user", message:{content:[...]}}` — tool_result blocks → `tool_result`
 *   (correlated to their `tool_use_id`). Plain text user turns are echoes
 *   of our own input; we don't re-project those.
 * - `{type:"result", duration_ms, total_tokens?, cost_usd?, num_turns?,
 *    is_error?}` → emit `usage` + `cost` + `turn_end` in that order.
 * - Anything that fails to parse as JSON → `error` with
 *   `errorCode: "amp_protocol_error"`, `fatal: false`, `retriable: false`.
 *   Do not crash on malformed lines.
 *
 * The projector is PURE: given a line + state, it emits zero-or-more
 * `AgentEvent`s. The caller (`AmpHandle`) manages redaction, validation,
 * queueing, and permission gating.
 *
 * ### State the projector holds
 *
 * - `sessionStartEmitted`: was a `session_start` emitted for this handle?
 * - `turnOpen`: is a turn currently open on the `CorrelationState`?
 * - `toolCallIds`: per-`tool_use_id` map to the shamu `ToolCallId` so
 *    `tool_result` events link back via `parentEventId`.
 * - `toolCallParents`: per-`tool_use_id` map to the eventId that emitted
 *    the `tool_call` (for `tool_result.parentEventId`).
 * - `toolCallsEmitted`: per-`tool_use_id` set so re-emitted assistant
 *    messages (amp sometimes re-yields the same assistant block with a
 *    growing message) don't double-emit.
 * - `toolResultsEmitted`: same idea for tool_result.
 * - `textCumulative`: per-`message_id` cumulative text the projector has
 *    seen, so re-emitted assistant messages can be diff'd into deltas.
 * - `lastUsage` / `lastCost`: stashed per-message usage snapshot for the
 *    terminal `{type:"result"}` emission.
 */

import type { AgentEvent, CorrelationState } from "@shamu/adapters-base";
import { type EventId, newToolCallId, type SessionId, type ToolCallId } from "@shamu/shared/ids";

/** Shape of state the projector carries across calls. */
export interface ProjectionState {
  sessionStartEmitted: boolean;
  turnOpen: boolean;
  /** `tool_use_id` → shamu `ToolCallId`. */
  readonly toolCallIds: Map<string, ToolCallId>;
  /** `tool_use_id` → eventId that emitted `tool_call`. */
  readonly toolCallParents: Map<string, EventId>;
  /** `tool_use_id` → "have we emitted tool_call yet?" */
  readonly toolCallsEmitted: Set<string>;
  /** `tool_use_id` → "have we emitted tool_result yet?" */
  readonly toolResultsEmitted: Set<string>;
  /** Assistant `message.id` → cumulative text emitted so far. */
  readonly textCumulative: Map<string, string>;
  /** Bound session id surfaced via `{type:"system"}`. */
  boundSessionId: SessionId | null;
  /** Model id surfaced via `{type:"system"}` or assistant message. */
  currentModel: string | null;
}

export function createProjectionState(): ProjectionState {
  return {
    sessionStartEmitted: false,
    turnOpen: false,
    toolCallIds: new Map(),
    toolCallParents: new Map(),
    toolCallsEmitted: new Set(),
    toolResultsEmitted: new Set(),
    textCumulative: new Map(),
    boundSessionId: null,
    currentModel: null,
  };
}

export interface ProjectionHooks {
  /** Invoked when the vendor `session_id` is first observed. */
  readonly onSessionBound?: (sessionId: SessionId) => void;
  /** Optional ULID factory for deterministic snapshot tests. */
  readonly newToolCallId?: () => ToolCallId;
  /** Returns the model id to stamp on `usage` events. */
  readonly modelProvider?: () => string;
}

/**
 * Context the projector needs. All fields are read or written by the
 * projector; the handle provides them.
 */
export interface ProjectionContext {
  readonly corr: CorrelationState;
  readonly state: ProjectionState;
  readonly sessionSource: "spawn" | "resume" | "fork";
  readonly hooks?: ProjectionHooks;
}

/**
 * Parse a raw JSONL line and project it into zero-or-more `AgentEvent`s.
 * Malformed JSON surfaces as a non-fatal `error` event; never throws.
 */
export function projectAmpLine(line: string, ctx: ProjectionContext): AgentEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    // Surface as non-fatal error; caller enqueues it. Make sure a turn is
    // open so the envelope has a valid turnId.
    openTurnIfNeeded(ctx);
    return [
      {
        ...ctx.corr.envelope(),
        kind: "error",
        fatal: false,
        errorCode: "amp_protocol_error",
        message: `Amp emitted unparseable JSONL line: ${truncate(trimmed, 240)}${
          (cause as Error)?.message ? ` (${(cause as Error).message})` : ""
        }`,
        retriable: false,
      },
    ];
  }
  if (!parsed || typeof parsed !== "object") return [];
  return projectAmpMessage(parsed as Record<string, unknown>, ctx);
}

/**
 * Project an already-parsed message object. Exported separately so tests can
 * drive the projector with typed fixtures.
 */
export function projectAmpMessage(
  msg: Record<string, unknown>,
  ctx: ProjectionContext,
): AgentEvent[] {
  const out: AgentEvent[] = [];
  const type = typeof msg.type === "string" ? (msg.type as string) : "";
  switch (type) {
    case "system": {
      const sessionId = pickStr(msg, "session_id") ?? pickStr(msg, "sessionId");
      const model = pickStr(msg, "model");
      if (sessionId && !ctx.state.boundSessionId) {
        const bound = sessionId as SessionId;
        ctx.state.boundSessionId = bound;
        ctx.corr.bindSession(bound);
        ctx.hooks?.onSessionBound?.(bound);
      }
      if (model) ctx.state.currentModel = model;
      if (!ctx.state.sessionStartEmitted) {
        ctx.state.sessionStartEmitted = true;
        openTurnIfNeeded(ctx);
        out.push({
          ...ctx.corr.envelope(),
          kind: "session_start",
          source: ctx.sessionSource,
        });
      }
      return out;
    }
    case "assistant": {
      const message = asObject(msg.message);
      if (!message) return out;
      const messageId = pickStr(message, "id") ?? "";
      const content = asArray(message.content);
      if (!content) return out;
      openTurnIfNeeded(ctx);
      for (const block of content) {
        const blockObj = asObject(block);
        if (!blockObj) continue;
        const btype = typeof blockObj.type === "string" ? (blockObj.type as string) : "";
        if (btype === "text") {
          const text = pickStr(blockObj, "text") ?? "";
          if (text.length === 0) continue;
          const prev = ctx.state.textCumulative.get(messageId) ?? "";
          let chunk = text;
          if (text.startsWith(prev) && prev.length > 0) {
            chunk = text.slice(prev.length);
          }
          ctx.state.textCumulative.set(messageId, text);
          if (chunk.length > 0) {
            out.push({
              ...ctx.corr.envelope(),
              kind: "assistant_delta",
              text: chunk,
            });
          }
        } else if (btype === "thinking" || btype === "reasoning") {
          const text =
            pickStr(blockObj, "text") ??
            pickStr(blockObj, "thinking") ??
            pickStr(blockObj, "content") ??
            "";
          if (text.length > 0) {
            out.push({
              ...ctx.corr.envelope(),
              kind: "reasoning",
              text,
            });
          }
        } else if (btype === "tool_use") {
          const useId = pickStr(blockObj, "id") ?? "";
          if (useId.length === 0) continue;
          if (ctx.state.toolCallsEmitted.has(useId)) continue;
          const toolName = pickStr(blockObj, "name") ?? "";
          const toolInput =
            (blockObj.input as Record<string, unknown> | undefined) ??
            (blockObj.args as Record<string, unknown> | undefined) ??
            {};
          const toolCallId = ctx.state.toolCallIds.get(useId) ?? mintToolCallId(ctx);
          ctx.state.toolCallIds.set(useId, toolCallId);
          const envelope = ctx.corr.envelope();
          // `eventId` on the envelope is schema-typed as a ULID string;
          // newEventId mints the brand so the cast is safe.
          const eventId = envelope.eventId as EventId;
          ctx.state.toolCallParents.set(useId, eventId);
          ctx.corr.rememberToolCall(toolCallId, eventId);
          out.push({
            ...envelope,
            kind: "tool_call",
            toolCallId,
            tool: toolName,
            args: toolInput,
          });
          ctx.state.toolCallsEmitted.add(useId);
        }
        // Unknown block types (e.g., "image", future types) are skipped —
        // amp's spec adds blocks additively.
      }
      return out;
    }
    case "user": {
      const message = asObject(msg.message);
      if (!message) return out;
      const content = asArray(message.content);
      if (!content) return out;
      for (const block of content) {
        const blockObj = asObject(block);
        if (!blockObj) continue;
        const btype = typeof blockObj.type === "string" ? (blockObj.type as string) : "";
        if (btype !== "tool_result") continue;
        const useId = pickStr(blockObj, "tool_use_id") ?? pickStr(blockObj, "toolUseId") ?? "";
        if (useId.length === 0) continue;
        if (ctx.state.toolResultsEmitted.has(useId)) continue;
        const toolCallId = ctx.state.toolCallIds.get(useId) ?? mintToolCallId(ctx);
        const parent = ctx.state.toolCallParents.get(useId) ?? null;
        const isError = blockObj.is_error === true || blockObj.isError === true;
        const rawContent = blockObj.content;
        const summary = stringifyResultContent(rawContent);
        const bytes = summary.length;
        openTurnIfNeeded(ctx);
        out.push({
          ...ctx.corr.envelope({ parentEventId: parent }),
          kind: "tool_result",
          toolCallId,
          ok: !isError,
          summary,
          bytes,
        });
        ctx.state.toolResultsEmitted.add(useId);
      }
      return out;
    }
    case "result": {
      openTurnIfNeeded(ctx);
      const durationMs =
        pickNum(msg, "duration_ms") ?? pickNum(msg, "durationMs") ?? pickNum(msg, "duration") ?? 0;
      // Amp surfaces usage either at the top level (total_tokens) or inside
      // a nested usage object; accept both.
      const usage = asObject(msg.usage) ?? msg;
      const input = pickNum(usage, "input_tokens") ?? pickNum(usage, "inputTokens") ?? 0;
      const output = pickNum(usage, "output_tokens") ?? pickNum(usage, "outputTokens") ?? 0;
      const reasoning = pickNum(usage, "reasoning_tokens") ?? pickNum(usage, "reasoningTokens");
      const cacheHits =
        pickNum(usage, "cache_read_input_tokens") ?? pickNum(usage, "cacheReadInputTokens") ?? 0;
      const cacheMisses =
        pickNum(usage, "cache_creation_input_tokens") ??
        pickNum(usage, "cacheCreationInputTokens") ??
        0;
      const model = ctx.hooks?.modelProvider?.() ?? ctx.state.currentModel ?? "amp-unknown";
      out.push({
        ...ctx.corr.envelope(),
        kind: "usage",
        model,
        tokens: {
          input,
          output,
          ...(reasoning !== undefined ? { reasoning } : {}),
        },
        cache: { hits: cacheHits, misses: cacheMisses },
      });
      out.push({
        ...ctx.corr.envelope(),
        kind: "cost",
        usd: null,
        confidence: "unknown",
        source: "subscription",
      });
      const isError = msg.is_error === true || msg.isError === true;
      const errorMessage = pickStr(msg, "error") ?? pickStr(msg, "error_message");
      const stopReason = isError
        ? (errorMessage ?? pickStr(msg, "stop_reason") ?? "error")
        : (pickStr(msg, "stop_reason") ?? pickStr(msg, "stopReason") ?? "end_turn");
      // On is_error, also emit an explicit `error` event before turn_end so
      // downstream consumers can discriminate structurally (not just via the
      // stopReason string). This keeps amp aligned with the Claude / Codex
      // error-surfaces contract.
      if (isError) {
        out.push({
          ...ctx.corr.envelope(),
          kind: "error",
          fatal: true,
          errorCode: "amp_turn_error",
          message: errorMessage ?? "amp turn ended with is_error",
          retriable: false,
        });
      }
      out.push({
        ...ctx.corr.envelope(),
        kind: "turn_end",
        stopReason,
        durationMs,
      });
      ctx.corr.endTurn();
      ctx.state.turnOpen = false;
      return out;
    }
    default:
      // Unknown message type — diagnostic-only. Amp may add types additively;
      // we surface the first-seen unknown as a non-fatal error so users notice,
      // but drop the rest so the stream doesn't become noisy.
      return out;
  }
}

/**
 * Convert amp's tool_result `content` field into a string summary. Amp's
 * examples show either a plain string, an array of `{type:"text", text:"..."}`
 * blocks, or a JSON object. We prefer a readable text rendering and fall
 * back to JSON.stringify for exotic shapes.
 */
function stringifyResultContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw === null || raw === undefined) return "";
  if (Array.isArray(raw)) {
    const pieces: string[] = [];
    for (const entry of raw) {
      if (typeof entry === "string") pieces.push(entry);
      else if (entry !== null && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (typeof e.text === "string") pieces.push(e.text);
        else pieces.push(safeJson(entry));
      }
    }
    return pieces.join("\n");
  }
  return safeJson(raw);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function pickStr(obj: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}

function pickNum(obj: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return null;
  if (Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

function openTurnIfNeeded(ctx: ProjectionContext): void {
  if (ctx.state.turnOpen) return;
  ctx.corr.startTurn();
  ctx.state.turnOpen = true;
}

function mintToolCallId(ctx: ProjectionContext): ToolCallId {
  return ctx.hooks?.newToolCallId ? ctx.hooks.newToolCallId() : newToolCallId();
}
