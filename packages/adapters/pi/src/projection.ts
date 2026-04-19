/**
 * Project Pi async events into `AgentEvent`s.
 *
 * Pi's RPC surface (per `github.com/badlogic/pi-mono/.../coding-agent/docs/rpc.md`)
 * emits these async event types (no `id`):
 *
 *   - `agent_start`               — agent is ready to accept prompts
 *   - `agent_end`                 — agent is shutting down
 *   - `turn_start`                — new turn begins
 *   - `message_start`             — an assistant message is starting
 *   - `message_update`            — streaming delta (text / thinking / tool-use)
 *   - `message_end`               — assistant message is finalized
 *   - `turn_end`                  — turn finished (carries stop reason)
 *   - `tool_execution_start`      — a tool is about to execute
 *   - `tool_execution_update`     — tool progress (stdout, step)
 *   - `tool_execution_end`        — tool finished (result + isError)
 *   - `queue_update`              — queue-mode change (steer / follow-up)
 *   - `compaction_start/end`      — context compaction
 *   - `auto_retry_start/end`      — retry-on-failure
 *   - `extension_error`           — Pi extension threw
 *   - `extension_ui_request`      — extension wants to prompt user
 *
 * And these "frames":
 *
 *   - `{type:"ready", ...}`     — handshake (consumed by the driver)
 *   - `{type:"response", ...}`  — response to a command (consumed by the
 *                                  rpc-client)
 *
 * ### Projection rules
 *
 *  - `agent_start` → no `AgentEvent`; used as a signal to emit the handle's
 *    synthetic `session_start` if one hasn't been emitted yet.
 *  - `turn_start` → opens a correlation-state turn if one isn't open.
 *  - `message_update` with `assistantMessageEvent.type === "text_delta"` →
 *    `assistant_delta`.
 *  - `message_update` with `assistantMessageEvent.type === "thinking_delta"` →
 *    `reasoning`.
 *  - `message_end` → `assistant_message` with the final text; stopReason
 *    comes from the next `turn_end` or the final `message_update` with
 *    `type: "done"`.
 *  - `tool_execution_start` → `tool_call` (runs G4/G5 gate in the HANDLE,
 *    not here — the projector is pure).
 *  - `tool_execution_end` → `tool_result`.
 *  - `turn_end` → `usage` + `cost` (null, subscription) + `turn_end`.
 *    Pi's `turn_end` carries `toolResults` + `message`; it does NOT
 *    carry usage tokens. We emit `usage` with zeroed counts; the
 *    orchestrator typically fetches real numbers via the `get_session_stats`
 *    command path (not projected here).
 *  - `agent_end` → `session_end` (best-effort; the handle's own
 *    `shutdown` is the primary emission site).
 *  - `extension_error` / `extension_ui_request` → `error` (non-fatal).
 *  - Unknown event types → `error` with `code: "pi_unknown_event"`,
 *    `fatal: false`, `retriable: false`. Loud-noise so spec drift is
 *    visible in CI.
 *
 * ### Tool-call single-source-of-truth rule (IMPORTANT)
 *
 * Pi's `message_update` with `assistantMessageEvent.type === "toolcall_*"`
 * carries tool-call information as part of the `AssistantMessage.content`
 * blocks. Pi ALSO emits a separate `tool_execution_*` event for the same
 * tool call. Projecting both would DOUBLE-COUNT tool calls in the
 * `AgentEvent` stream.
 *
 * **We project tool calls from the `tool_execution_*` event stream only.**
 * `message_update`'s `toolcall_*` assistant-message events are silently
 * consumed (no output). This is the mission's documented invariant.
 */

import type { AgentEvent, CorrelationState } from "@shamu/adapters-base";
import { type EventId, newToolCallId, type SessionId, type ToolCallId } from "@shamu/shared/ids";

// ---- Projector state -------------------------------------------------------

export interface ProjectionState {
  /** Has the adapter emitted `session_start` yet? */
  sessionStartEmitted: boolean;
  /** Is there an open turn in the correlation state? */
  turnOpen: boolean;
  /** Assistant message accumulated across `text_delta` events for the current message. */
  assistantTextBuffer: string;
  /** Stop reason latched from `message_update` `done` events. */
  assistantStopReason: string | null;
  /** `toolCallId` → shamu-minted `ToolCallId`. */
  readonly toolCallIds: Map<string, ToolCallId>;
  /** `toolCallId` → `EventId` of the emitted `tool_call` (for `parentEventId`). */
  readonly toolCallParents: Map<string, EventId>;
  /** `toolCallId` → "did we already emit the `tool_call`?" */
  readonly toolCallsEmitted: Set<string>;
  /** `toolCallId` → "did we already emit the `tool_result`?" */
  readonly toolResultsEmitted: Set<string>;
  /** `toolCallId` → the original tool name (from tool_execution_start). */
  readonly toolCallNames: Map<string, string>;
  /** `toolCallId` → the original args (from tool_execution_start). Pi's tool_execution_end does NOT carry args, so we stash them here for patch_applied synthesis. */
  readonly toolCallArgs: Map<string, Readonly<Record<string, unknown>>>;
  /** Tracks the shamu-bound sessionId (Pi's sessionId, round-tripped). */
  boundSessionId: SessionId | null;
}

export function createProjectionState(): ProjectionState {
  return {
    sessionStartEmitted: false,
    turnOpen: false,
    assistantTextBuffer: "",
    assistantStopReason: null,
    toolCallIds: new Map(),
    toolCallParents: new Map(),
    toolCallsEmitted: new Set(),
    toolResultsEmitted: new Set(),
    toolCallNames: new Map(),
    toolCallArgs: new Map(),
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
  /** The vendor session id we bound at spawn / resume time. */
  readonly targetSessionId: string | null;
  readonly hooks?: ProjectionHooks;
}

/**
 * Project a single Pi async event. Returns zero or more `AgentEvent`s; the
 * caller (`PiHandle`) enqueues them.
 *
 * Pure function: given the same event + state, emits the same output.
 */
export function projectPiEvent(
  ev: Readonly<Record<string, unknown>>,
  ctx: ProjectionContext,
): AgentEvent[] {
  const out: AgentEvent[] = [];
  const type = typeof ev.type === "string" ? (ev.type as string) : "";
  if (!type) return out;

  switch (type) {
    case "ready":
    case "response":
      // Consumed at the rpc-client layer — do not project.
      return out;

    case "agent_start": {
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

    case "agent_end": {
      // The handle owns the session_end emission on shutdown; we surface
      // Pi's `agent_end` as a non-fatal `error` for visibility so a
      // consumer that cares about drift sees it.
      openTurnIfNeeded(ctx);
      out.push({
        ...ctx.corr.envelope(),
        kind: "session_end",
        reason: "agent_end",
      });
      if (ctx.state.turnOpen) {
        ctx.corr.endTurn();
        ctx.state.turnOpen = false;
      }
      return out;
    }

    case "turn_start": {
      openTurnIfNeeded(ctx);
      // Reset per-turn accumulators.
      ctx.state.assistantTextBuffer = "";
      ctx.state.assistantStopReason = null;
      return out;
    }

    case "message_start": {
      openTurnIfNeeded(ctx);
      ctx.state.assistantTextBuffer = "";
      return out;
    }

    case "message_update": {
      return projectMessageUpdate(ev, ctx);
    }

    case "message_end": {
      openTurnIfNeeded(ctx);
      const text = ctx.state.assistantTextBuffer;
      if (text.length > 0) {
        out.push({
          ...ctx.corr.envelope(),
          kind: "assistant_message",
          text,
          stopReason: ctx.state.assistantStopReason ?? "end_turn",
        });
      }
      ctx.state.assistantTextBuffer = "";
      return out;
    }

    case "tool_execution_start": {
      return projectToolStart(ev, ctx);
    }

    case "tool_execution_update": {
      // Tool-progress events carry stdout/stderr chunks optionally; we
      // don't surface them today to keep the stream bounded. A future
      // revision that maps `args.output` → `stdout` can land here.
      return out;
    }

    case "tool_execution_end": {
      return projectToolEnd(ev, ctx);
    }

    case "turn_end": {
      if (!ctx.state.turnOpen) openTurnIfNeeded(ctx);
      const stopReason = getString(ev, "stop_reason") ?? getString(ev, "stopReason") ?? "end_turn";
      out.push(...emitUsageAndCost(ctx));
      out.push({
        ...ctx.corr.envelope(),
        kind: "turn_end",
        stopReason,
        durationMs: 0,
      });
      ctx.corr.endTurn();
      ctx.state.turnOpen = false;
      ctx.state.assistantTextBuffer = "";
      ctx.state.assistantStopReason = null;
      return out;
    }

    case "extension_error": {
      openTurnIfNeeded(ctx);
      const extensionPath = getString(ev, "extensionPath") ?? "<unknown>";
      const errEvent = getString(ev, "event") ?? "<unknown>";
      const errMsg = getString(ev, "error") ?? "extension error";
      out.push({
        ...ctx.corr.envelope(),
        kind: "error",
        fatal: false,
        errorCode: "pi_extension_error",
        message: `Pi extension ${JSON.stringify(extensionPath)} failed during ${errEvent}: ${errMsg}`,
        retriable: false,
      });
      return out;
    }

    case "extension_ui_request": {
      openTurnIfNeeded(ctx);
      out.push({
        ...ctx.corr.envelope(),
        kind: "error",
        fatal: false,
        errorCode: "pi_extension_ui_request",
        message:
          "Pi extension requested user UI — shamu's daemon does not support interactive UI requests",
        retriable: false,
      });
      return out;
    }

    // Queue / compaction / auto-retry events: diagnostic-only today.
    case "queue_update":
    case "compaction_start":
    case "compaction_end":
    case "auto_retry_start":
    case "auto_retry_end":
      return out;

    default: {
      // Unknown event — emit a non-fatal error so spec drift is visible.
      openTurnIfNeeded(ctx);
      out.push({
        ...ctx.corr.envelope(),
        kind: "error",
        fatal: false,
        errorCode: "pi_unknown_event",
        message: `Pi async event type not recognized: ${JSON.stringify(type)}`,
        retriable: false,
      });
      return out;
    }
  }
}

function projectMessageUpdate(
  ev: Readonly<Record<string, unknown>>,
  ctx: ProjectionContext,
): AgentEvent[] {
  const out: AgentEvent[] = [];
  openTurnIfNeeded(ctx);
  const inner = ev.assistantMessageEvent;
  if (!inner || typeof inner !== "object") return out;
  const innerObj = inner as Record<string, unknown>;
  const subtype = typeof innerObj.type === "string" ? (innerObj.type as string) : "";

  switch (subtype) {
    case "text_delta": {
      const delta = typeof innerObj.delta === "string" ? (innerObj.delta as string) : "";
      if (delta.length === 0) return out;
      ctx.state.assistantTextBuffer += delta;
      out.push({
        ...ctx.corr.envelope(),
        kind: "assistant_delta",
        text: delta,
      });
      return out;
    }
    case "thinking_delta": {
      const delta = typeof innerObj.delta === "string" ? (innerObj.delta as string) : "";
      if (delta.length === 0) return out;
      out.push({
        ...ctx.corr.envelope(),
        kind: "reasoning",
        text: delta,
      });
      return out;
    }
    case "done": {
      const reason = typeof innerObj.reason === "string" ? (innerObj.reason as string) : "";
      if (reason.length > 0) ctx.state.assistantStopReason = reason;
      return out;
    }
    case "error": {
      const reason = typeof innerObj.reason === "string" ? (innerObj.reason as string) : "";
      out.push({
        ...ctx.corr.envelope(),
        kind: "error",
        fatal: false,
        errorCode: "pi_message_error",
        message: `Pi assistant message errored: ${reason || "unknown"}`,
        retriable: reason === "aborted",
      });
      return out;
    }
    // Tool-call events embedded in the assistant message are NOT projected —
    // see the module header's "single-source-of-truth" rule. Pi emits
    // `tool_execution_*` events for the same tool calls.
    case "text_start":
    case "text_end":
    case "thinking_start":
    case "thinking_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
      return out;
    default:
      return out;
  }
}

function projectToolStart(
  ev: Readonly<Record<string, unknown>>,
  ctx: ProjectionContext,
): AgentEvent[] {
  const out: AgentEvent[] = [];
  openTurnIfNeeded(ctx);
  const vendorId = getString(ev, "toolCallId") ?? getString(ev, "tool_id");
  const toolName = getString(ev, "toolName") ?? getString(ev, "name") ?? "unknown_tool";
  const args = (ev.args ?? ev.input) as Record<string, unknown> | undefined;
  if (!vendorId) return out;
  if (ctx.state.toolCallsEmitted.has(vendorId)) return out;

  const toolCallId =
    ctx.state.toolCallIds.get(vendorId) ??
    (ctx.hooks?.newToolCallId ? ctx.hooks.newToolCallId() : newToolCallId());
  ctx.state.toolCallIds.set(vendorId, toolCallId);
  // Stash tool name + args so `projectToolEnd` can synthesize
  // `patch_applied` events for write-class tools. Pi's
  // `tool_execution_end` frame does NOT include the original args.
  ctx.state.toolCallNames.set(vendorId, toolName);
  if (args) ctx.state.toolCallArgs.set(vendorId, args);
  const envelope = ctx.corr.envelope();
  const eventId = envelope.eventId as EventId;
  ctx.state.toolCallParents.set(vendorId, eventId);
  ctx.corr.rememberToolCall(toolCallId, eventId);
  out.push({
    ...envelope,
    kind: "tool_call",
    toolCallId,
    tool: toolName,
    args: args ?? {},
  });
  ctx.state.toolCallsEmitted.add(vendorId);
  return out;
}

function projectToolEnd(
  ev: Readonly<Record<string, unknown>>,
  ctx: ProjectionContext,
): AgentEvent[] {
  const out: AgentEvent[] = [];
  const vendorId = getString(ev, "toolCallId") ?? getString(ev, "tool_id");
  if (!vendorId) return out;
  if (ctx.state.toolResultsEmitted.has(vendorId)) return out;
  openTurnIfNeeded(ctx);
  const toolCallId =
    ctx.state.toolCallIds.get(vendorId) ??
    (ctx.hooks?.newToolCallId ? ctx.hooks.newToolCallId() : newToolCallId());
  ctx.state.toolCallIds.set(vendorId, toolCallId);
  const parent = ctx.state.toolCallParents.get(vendorId) ?? null;
  const isError = ev.isError === true || ev.is_error === true;
  const ok = !isError;
  const summary = extractToolSummary(ev);
  out.push({
    ...ctx.corr.envelope({ parentEventId: parent }),
    kind: "tool_result",
    toolCallId,
    ok,
    summary,
    bytes: summary.length,
  });
  ctx.state.toolResultsEmitted.add(vendorId);

  // Synthesize `patch_applied` for successful write/edit-class tools.
  // Pi's event dictionary does NOT carry explicit patch metadata — we
  // reconstruct it by inspecting the originating tool_execution_start's
  // args (captured in state when the tool_call was emitted). The adapter
  // declares `patchVisibility: "events"` so downstream consumers expect
  // a `patch_applied` for every file mutation.
  if (ok) {
    const toolName = (
      getString(ev, "toolName") ??
      getString(ev, "name") ??
      ctx.state.toolCallNames.get(vendorId) ??
      ""
    ).toLowerCase();
    if (isWriteClassTool(toolName)) {
      const stashedArgs = ctx.state.toolCallArgs.get(vendorId);
      const liveArgs = (ev.args ?? ev.input) as Record<string, unknown> | undefined;
      const inputLike = liveArgs ?? stashedArgs;
      const files = inputLike ? collectPathsFromInput(inputLike) : [];
      if (files.length > 0) {
        out.push({
          ...ctx.corr.envelope({ parentEventId: parent }),
          kind: "patch_applied",
          files,
          // Pi's tool_execution_end does not carry add/del line counts.
          // Emit zeros — a future projector revision (Pi exposes counts
          // upstream) can populate them. See handoff followups.
          stats: { add: 0, del: 0 },
        });
      }
    }
  }
  return out;
}

function isWriteClassTool(name: string): boolean {
  return (
    name === "write" ||
    name === "edit" ||
    name === "create" ||
    name === "delete" ||
    name === "patch" ||
    name === "apply_patch" ||
    name === "rename" ||
    name === "write_file" ||
    name === "edit_file"
  );
}

function collectPathsFromInput(input: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  const keys = [
    "file_path",
    "path",
    "filename",
    "target",
    "destination",
    "abs_path",
    "absolutePath",
  ];
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  for (const k of ["files", "paths", "patches"]) {
    const v = input[k];
    if (Array.isArray(v)) {
      for (const entry of v) {
        if (typeof entry === "string" && entry.length > 0) out.push(entry);
        else if (
          entry !== null &&
          typeof entry === "object" &&
          typeof (entry as { path?: unknown }).path === "string"
        ) {
          out.push((entry as { path: string }).path);
        }
      }
    }
  }
  return out;
}

function extractToolSummary(ev: Readonly<Record<string, unknown>>): string {
  // Pi's `tool_execution_end` carries `result.content[].text` per the docs.
  const result = ev.result;
  if (typeof result === "string") return result;
  if (result !== null && typeof result === "object") {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const entry of content) {
        if (entry && typeof entry === "object") {
          const t = (entry as { text?: unknown }).text;
          if (typeof t === "string") parts.push(t);
        }
      }
      if (parts.length > 0) return parts.join("");
    }
    const text = (result as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  // Failure path — prefer an explicit error message.
  const err = ev.error;
  if (typeof err === "string") return err;
  if (err !== null && typeof err === "object") {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return "";
}

/**
 * Emit the `usage` + `cost` pair that precedes a `turn_end`.
 *
 * Pi's `turn_end` event does NOT carry usage tokens — token/cost totals
 * live behind the `get_session_stats` command (synchronous RPC path). We
 * emit zeroed `usage` + null `cost` here for schema validity; the handle
 * can overlay real numbers via an orchestrator-driven stats fetch in a
 * future revision (followup flagged in the handoff).
 */
function emitUsageAndCost(ctx: ProjectionContext): AgentEvent[] {
  const model = ctx.hooks?.modelProvider?.() ?? "pi-unknown";
  return [
    {
      ...ctx.corr.envelope(),
      kind: "usage",
      model,
      tokens: { input: 0, output: 0 },
      cache: { hits: 0, misses: 0 },
    },
    {
      ...ctx.corr.envelope(),
      kind: "cost",
      usd: null,
      confidence: "unknown",
      source: "subscription",
    },
  ];
}

function openTurnIfNeeded(ctx: ProjectionContext): void {
  if (ctx.state.turnOpen) return;
  ctx.corr.startTurn();
  ctx.state.turnOpen = true;
}

function getString(obj: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" ? v : undefined;
}
