/**
 * Project OpenCode SDK events into `AgentEvent`s.
 *
 * OpenCode surfaces a single `Event` union (see
 * `@opencode-ai/sdk/dist/gen/types.gen.d.ts`). We care about:
 *
 * - `session.created` / `session.updated` → `session_start` (once per session)
 * - `session.idle`                       → end-of-turn trigger (handle emits `turn_end`)
 * - `session.error`                      → `error`
 * - `message.updated` for an AssistantMessage (role=assistant) with
 *    `finish` set → also end-of-turn; token + cost snapshot lands here
 * - `message.part.updated` with `TextPart`   → `assistant_delta`
 * - `message.part.updated` with `ReasoningPart` → `reasoning`
 * - `message.part.updated` with `ToolPart`   → `tool_call` (on pending/running)
 *                                              or `tool_result` (on completed/error)
 * - `message.part.updated` with `PatchPart`   → `patch_applied`
 * - `permission.updated`                 → `permission_request`
 * - `file.watcher.updated` / `file.edited` → (currently no-op;
 *   PLAN's `patchVisibility` is "events" and the `patch` part already
 *   carries the file list — these are diagnostic only.)
 *
 * The projector is PURE: given an event + state, it emits zero-or-more
 * `AgentEvent`s. The caller (`OpencodeHandle`) manages redaction, validation,
 * and queueing.
 *
 * ### State the projector holds
 *
 * - `turnOpen`: set when a `session_start` has been emitted and the first
 *   assistant message is in flight; cleared on `turn_end` emission.
 * - `toolCallParents`: per-`callID` map from the vendor callID to the
 *   shamu-minted `EventId` so subsequent `tool_result` events link back.
 * - `toolCallPart`: per-`callID` map from `callID` to the projected
 *   `tool_call` event; needed because OpenCode surfaces both the initial
 *   pending state and the final completed state via `message.part.updated`,
 *   and we only emit the `tool_call` on the first appearance.
 * - `assistantFinish`: set when the assistant message's `finish` is seen;
 *   becomes the `turn_end.stopReason` later.
 *
 * ### Not in this module
 *
 * - Gate (`decideOpencodePermission`) — runs in the handle BEFORE the
 *   projector so a denied tool-call can be short-circuited.
 * - Redaction — applied in the handle's enqueue path.
 */

import type { AgentEvent, CorrelationState } from "@shamu/adapters-base";
import { type EventId, newToolCallId, type SessionId, type ToolCallId } from "@shamu/shared/ids";

// ---- SDK event shape (re-declared structurally) ---------------------------
//
// We import these from the SDK for compile-time safety but don't re-export
// them — the base-package contract never speaks opencode types.

import type { AssistantMessage, Event as OpencodeEvent, Part } from "@opencode-ai/sdk";

export interface ProjectionState {
  /** Has the adapter emitted `session_start` yet? */
  sessionStartEmitted: boolean;
  /** Is there an open turn in the correlation state? */
  turnOpen: boolean;
  /** Assistant message whose `finish` field will become `turn_end.stopReason`. */
  assistantFinish: string | null;
  /** Last token/cost snapshot from `message.updated` (assistant). */
  lastAssistant: AssistantMessage | null;
  /** `callID` → shamu-minted `ToolCallId` (so subsequent results link). */
  readonly toolCallIds: Map<string, ToolCallId>;
  /** `callID` → eventId of the tool_call event (for `parentEventId` linkage). */
  readonly toolCallParents: Map<string, EventId>;
  /** `callID` → "did we already emit the tool_call?" */
  readonly toolCallsEmitted: Set<string>;
  /** `callID` → "did we already emit the tool_result?" */
  readonly toolResultsEmitted: Set<string>;
  /** Text `part.id` → cumulative text emitted. Used to diff deltas. */
  readonly textPartCumulative: Map<string, string>;
  /** Tracks the shamu-bound sessionId (vendor `sessionID` round-tripped). */
  boundSessionId: SessionId | null;
  /**
   * Message ids for messages with `role: "user"`. OpenCode's SSE stream
   * emits `message.part.updated` events for the user's prompt text parts
   * too, not just the assistant's streamed output. Without this filter the
   * projector would re-emit the user's prompt as `assistant_delta` — a
   * confidentiality-boundary violation for anyone who redacts the assistant
   * stream expecting it to be model output only. Populated from
   * `message.updated` when `role === "user"`.
   */
  readonly userMessageIds: Set<string>;
  /**
   * Message ids confirmed to belong to the assistant. We require the role
   * to be explicitly observed via `message.updated` before emitting any
   * text/reasoning part — otherwise an out-of-order part-update whose
   * containing message hasn't been announced yet could leak the user's
   * prompt as `assistant_delta`. Parts that arrive before the role is
   * known are buffered in `pendingParts` until `message.updated` confirms
   * the role; tool/patch parts are excluded from this gate because they
   * never carry prompt text and OpenCode dispatches them from the server.
   */
  readonly assistantMessageIds: Set<string>;
  /**
   * Buffered text/reasoning parts whose containing `messageID` has not
   * yet been classified. Drained when `message.updated` lands with a
   * role. Keyed by messageID; values preserve arrival order.
   */
  readonly pendingParts: Map<string, Array<{ part: Part; delta: string | undefined }>>;
}

export function createProjectionState(): ProjectionState {
  return {
    sessionStartEmitted: false,
    turnOpen: false,
    assistantFinish: null,
    lastAssistant: null,
    toolCallIds: new Map(),
    toolCallParents: new Map(),
    toolCallsEmitted: new Set(),
    toolResultsEmitted: new Set(),
    textPartCumulative: new Map(),
    boundSessionId: null,
    userMessageIds: new Set(),
    assistantMessageIds: new Set(),
    pendingParts: new Map(),
  };
}

export interface ProjectionHooks {
  /** Invoked when the vendor `sessionID` is first observed. */
  readonly onSessionBound?: (sessionId: SessionId) => void;
  /** Optional ULID factory for deterministic snapshot tests. */
  readonly newToolCallId?: () => ToolCallId;
  /** Returns the model id to stamp on `usage` events. */
  readonly modelProvider?: () => string;
}

/**
 * Project a single SDK event. Returns zero or more `AgentEvent`s; the
 * caller enqueues them.
 *
 * Scoping: events whose `sessionID` doesn't match our bound session are
 * silently dropped. OpenCode's SSE stream is process-scoped (not session-
 * scoped) — we filter to our run's session so multiple runs sharing one
 * attached server don't cross-contaminate.
 */
export function projectOpencodeEvent(ev: OpencodeEvent, ctx: ProjectionContext): AgentEvent[] {
  const out: AgentEvent[] = [];
  switch (ev.type) {
    case "session.created":
    case "session.updated": {
      const info = ev.properties.info;
      if (!matchesSession(info.id, ctx)) return out;
      bindSessionIfNeeded(info.id, ctx);
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
    case "session.idle": {
      if (!matchesSession(ev.properties.sessionID, ctx)) return out;
      if (ctx.state.turnOpen) {
        out.push(...emitUsageAndCost(ctx));
        out.push({
          ...ctx.corr.envelope(),
          kind: "turn_end",
          stopReason: ctx.state.assistantFinish ?? "idle",
          durationMs: 0,
        });
        ctx.corr.endTurn();
        ctx.state.turnOpen = false;
        ctx.state.assistantFinish = null;
      }
      return out;
    }
    case "session.error": {
      if (ev.properties.sessionID && !matchesSession(ev.properties.sessionID, ctx)) return out;
      const err = ev.properties.error;
      const errorCode = err?.name ?? "opencode_session_error";
      const message = (err?.data as { message?: string } | undefined)?.message ?? "session error";
      openTurnIfNeeded(ctx);
      out.push({
        ...ctx.corr.envelope(),
        kind: "error",
        fatal: true,
        errorCode,
        message,
        retriable: isRetriable(err),
      });
      return out;
    }
    case "message.updated": {
      const info = ev.properties.info;
      if (!matchesSession(info.sessionID, ctx)) return out;
      if (info.role === "user") {
        // Remember this id so subsequent `message.part.updated` events
        // whose parts belong to the user's own prompt message aren't
        // re-emitted as `assistant_delta` / `assistant_message`. Drop any
        // buffered parts for this message — they belong to the user.
        ctx.state.userMessageIds.add(info.id);
        ctx.state.pendingParts.delete(info.id);
        return out;
      }
      if (info.role !== "assistant") return out;
      ctx.state.assistantMessageIds.add(info.id);
      ctx.state.lastAssistant = info;
      if (info.finish) {
        ctx.state.assistantFinish = info.finish;
      }
      // Drain any text/reasoning parts that arrived before this
      // message.updated confirmed the assistant role.
      const pending = ctx.state.pendingParts.get(info.id);
      if (pending) {
        ctx.state.pendingParts.delete(info.id);
        for (const entry of pending) {
          out.push(...projectPart(entry.part, entry.delta, ctx));
        }
      }
      return out;
    }
    case "message.part.updated": {
      const part = ev.properties.part;
      if (!matchesSession(part.sessionID, ctx)) return out;
      if (ctx.state.userMessageIds.has(part.messageID)) {
        // User-prompt parts echo back on the SSE stream; drop them — they
        // already round-tripped through `handle.send()`.
        return out;
      }
      // Text + reasoning parts are privileged (they shape the assistant
      // stream) — require an explicit assistant `message.updated` before
      // projecting. Buffer parts that arrive before the role is known.
      // Tool/patch/file/step/snapshot/agent/retry/compaction/subtask parts
      // are server-dispatched and safe to project immediately; OpenCode
      // never routes prompt text through them.
      const privileged = part.type === "text" || part.type === "reasoning";
      if (privileged && !ctx.state.assistantMessageIds.has(part.messageID)) {
        const buf = ctx.state.pendingParts.get(part.messageID) ?? [];
        buf.push({ part, delta: ev.properties.delta });
        ctx.state.pendingParts.set(part.messageID, buf);
        return out;
      }
      return projectPart(part, ev.properties.delta, ctx);
    }
    case "permission.updated": {
      const perm = ev.properties;
      if (!matchesSession(perm.sessionID, ctx)) return out;
      const callID = perm.callID ?? perm.id;
      const toolCallId = ctx.state.toolCallIds.get(callID) ?? mintToolCallId(ctx);
      ctx.state.toolCallIds.set(callID, toolCallId);
      openTurnIfNeeded(ctx);
      out.push({
        ...ctx.corr.envelope(),
        kind: "permission_request",
        toolCallId,
        decision: "pending",
      });
      return out;
    }
    case "permission.replied": {
      if (!matchesSession(ev.properties.sessionID, ctx)) return out;
      // The response string is `"allow" | "deny" | "allow_always"` etc.
      const raw = ev.properties.response;
      const decision = normalizePermissionDecision(raw);
      const callID = ev.properties.permissionID;
      const toolCallId = ctx.state.toolCallIds.get(callID) ?? mintToolCallId(ctx);
      ctx.state.toolCallIds.set(callID, toolCallId);
      openTurnIfNeeded(ctx);
      out.push({
        ...ctx.corr.envelope(),
        kind: "permission_request",
        toolCallId,
        decision,
      });
      return out;
    }
    // Events that are diagnostic-only for the adapter contract today.
    default:
      return out;
  }
}

function projectPart(part: Part, delta: string | undefined, ctx: ProjectionContext): AgentEvent[] {
  const out: AgentEvent[] = [];
  openTurnIfNeeded(ctx);

  switch (part.type) {
    case "text": {
      const prev = ctx.state.textPartCumulative.get(part.id) ?? "";
      const next = part.text ?? "";
      // Prefer the caller-supplied delta; otherwise diff.
      let chunk = delta ?? "";
      if (!chunk) {
        if (next.startsWith(prev)) chunk = next.slice(prev.length);
        else chunk = next;
      }
      ctx.state.textPartCumulative.set(part.id, next);
      if (part.time?.end !== undefined) {
        // Terminal text part: emit the final assistant_message so consumers
        // have a completion signal; redact + stop reason come via the
        // enclosing message.
        out.push({
          ...ctx.corr.envelope(),
          kind: "assistant_message",
          text: next,
          stopReason: ctx.state.assistantFinish ?? "end_turn",
        });
      } else if (chunk.length > 0) {
        out.push({
          ...ctx.corr.envelope(),
          kind: "assistant_delta",
          text: chunk,
        });
      }
      return out;
    }
    case "reasoning": {
      if (!part.text) return out;
      out.push({
        ...ctx.corr.envelope(),
        kind: "reasoning",
        text: part.text,
      });
      return out;
    }
    case "tool": {
      const callID = part.callID;
      const state = part.state;
      if (!ctx.state.toolCallsEmitted.has(callID)) {
        const toolCallId = ctx.state.toolCallIds.get(callID) ?? mintToolCallId(ctx);
        ctx.state.toolCallIds.set(callID, toolCallId);
        const envelope = ctx.corr.envelope();
        // `eventId` on the envelope is typed as `string` (schema-level) but
        // is minted by `newEventId()` which returns the `EventId` brand.
        // The cast is safe — ULID validation happens at enqueue time via
        // the full `AgentEvent` schema parse.
        const eventId = envelope.eventId as EventId;
        ctx.state.toolCallParents.set(callID, eventId);
        ctx.corr.rememberToolCall(toolCallId, eventId);
        out.push({
          ...envelope,
          kind: "tool_call",
          toolCallId,
          tool: part.tool,
          args: state.input ?? {},
        });
        ctx.state.toolCallsEmitted.add(callID);
      }
      if (state.status === "completed" || state.status === "error") {
        if (ctx.state.toolResultsEmitted.has(callID)) return out;
        const toolCallId = ctx.state.toolCallIds.get(callID) ?? mintToolCallId(ctx);
        const parent = ctx.state.toolCallParents.get(callID) ?? null;
        const ok = state.status === "completed";
        const summary = ok
          ? ((state as { output?: string }).output ?? "")
          : ((state as { error?: string }).error ?? "error");
        const bytes = summary.length;
        out.push({
          ...ctx.corr.envelope({ parentEventId: parent }),
          kind: "tool_result",
          toolCallId,
          ok,
          summary,
          bytes,
        });
        ctx.state.toolResultsEmitted.add(callID);
      }
      return out;
    }
    case "patch": {
      out.push({
        ...ctx.corr.envelope(),
        kind: "patch_applied",
        files: [...part.files],
        // OpenCode doesn't surface add/del line counts on the patch part
        // (only the file list). Zero is accurate per the schema: we don't
        // have the numbers. A future SDK release that does expose them
        // should land here.
        stats: { add: 0, del: 0 },
      });
      return out;
    }
    case "step-finish": {
      // `step-finish` carries token + cost totals for a step. We use it as
      // a signal to stash the final counts; `session.idle` triggers the
      // eventual `turn_end` + usage/cost emission.
      ctx.state.lastAssistant = {
        ...(ctx.state.lastAssistant ?? ({} as AssistantMessage)),
        cost: part.cost,
        tokens: part.tokens,
      };
      return out;
    }
    // Structural noise the adapter doesn't surface today.
    case "file":
    case "step-start":
    case "snapshot":
    case "agent":
    case "retry":
    case "compaction":
    case "subtask":
      return out;
    default: {
      const exhaustive: never = part;
      void exhaustive;
      return out;
    }
  }
}

/**
 * Emit the `usage` + `cost` pair that always precedes a `turn_end` in our
 * stream. Uses the last assistant message's token + cost snapshot.
 *
 * Cost `usd` is clobbered to `null` regardless of what `lastAssistant.cost`
 * says — the adapter declares `costReporting: "subscription"` (PLAN), so
 * the core is authoritative (T17). The `cost-stamping` helper in
 * `@shamu/adapters-base` will re-stamp downstream; we just write a valid
 * shape here.
 */
function emitUsageAndCost(ctx: ProjectionContext): AgentEvent[] {
  const out: AgentEvent[] = [];
  const last = ctx.state.lastAssistant;
  const tokens = last?.tokens ?? {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  const model = ctx.hooks?.modelProvider?.() ?? last?.modelID ?? "opencode-unknown";
  out.push({
    ...ctx.corr.envelope(),
    kind: "usage",
    model,
    tokens: {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      ...(tokens.reasoning !== undefined ? { reasoning: tokens.reasoning } : {}),
    },
    cache: {
      hits: tokens.cache?.read ?? 0,
      misses: tokens.cache?.write ?? 0,
    },
  });
  out.push({
    ...ctx.corr.envelope(),
    kind: "cost",
    usd: null,
    confidence: "unknown",
    source: "subscription",
  });
  return out;
}

/**
 * Context the projector needs. All fields are read or written by the
 * projector; the handle provides them.
 */
export interface ProjectionContext {
  readonly corr: CorrelationState;
  readonly state: ProjectionState;
  readonly sessionSource: "spawn" | "resume" | "fork";
  /** The vendor session id we bound at spawn / resume time. */
  readonly targetSessionId: string | null;
  readonly hooks?: ProjectionHooks;
}

function matchesSession(vendorId: string | undefined, ctx: ProjectionContext): boolean {
  if (!vendorId) return true;
  if (!ctx.targetSessionId) {
    // We haven't bound yet (server created the session for us); accept
    // the first one seen. `projectOpencodeEvent` binds via
    // `bindSessionIfNeeded`.
    return true;
  }
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

function mintToolCallId(ctx: ProjectionContext): ToolCallId {
  return ctx.hooks?.newToolCallId ? ctx.hooks.newToolCallId() : newToolCallId();
}

function normalizePermissionDecision(
  raw: string,
): Extract<AgentEvent, { kind: "permission_request" }>["decision"] {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("allow")) return "allow";
  if (s.includes("deny") || s.includes("reject")) return "deny";
  if (s === "ask") return "ask";
  return "pending";
}

function isRetriable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  if (name === "APIError") {
    const data = (err as { data?: { isRetryable?: boolean } }).data;
    return !!data?.isRetryable;
  }
  return false;
}
