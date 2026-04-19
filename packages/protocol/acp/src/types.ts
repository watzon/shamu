/**
 * ACP method dictionary — the slice Shamu cares about.
 *
 * The Agent Client Protocol spec (agentclientprotocol.com / protocolVersion: 1)
 * defines more methods than we wire here; this module captures the ones every
 * Shamu adapter needs:
 *
 * - `initialize` — protocol version negotiation, capability advertisement.
 * - `authenticate` — a generic method the agent dispatches on; the adapter
 *   supplies the method name (`cursor_login` for Cursor, `authenticate` for
 *   Gemini) and any params the vendor expects.
 * - `session/new`, `session/load`, `session/prompt`, `session/cancel`.
 * - `session/update` (notification, incoming).
 * - `session/request_permission` (server-initiated request, incoming).
 *
 * All types are intentionally permissive on nested fields — every ACP server
 * is free to add vendor-specific data; we preserve it via `unknown` rather
 * than reject it at the protocol layer. Adapters narrow as needed.
 *
 * Type shape is structural JSON-over-the-wire; we do NOT add brands or Zod
 * parsers here. Validation of individual notifications is the adapter's job —
 * it has the context to know which `session/update.kind` values it projects
 * and which it drops.
 */

export type AcpJsonRpcId = string | number;

/** A single JSON-RPC 2.0 request frame. */
export interface AcpRequestFrame<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: AcpJsonRpcId;
  readonly method: string;
  readonly params?: TParams;
}

/** A JSON-RPC 2.0 success response. */
export interface AcpSuccessResponseFrame<TResult = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: AcpJsonRpcId;
  readonly result: TResult;
}

/** A JSON-RPC 2.0 error response. */
export interface AcpErrorResponseFrame {
  readonly jsonrpc: "2.0";
  readonly id: AcpJsonRpcId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

/** A JSON-RPC 2.0 notification (no id). */
export interface AcpNotificationFrame<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: TParams;
}

export type AcpFrame =
  | AcpRequestFrame
  | AcpSuccessResponseFrame
  | AcpErrorResponseFrame
  | AcpNotificationFrame;

// ---- Lifecycle -----------------------------------------------------------

export interface AcpInitializeParams {
  readonly protocolVersion: number;
  readonly clientCapabilities?: Readonly<Record<string, unknown>>;
  readonly clientInfo?: Readonly<{ name: string; version?: string }>;
}

export interface AcpInitializeResult {
  readonly protocolVersion: number;
  readonly agentCapabilities?: Readonly<Record<string, unknown>>;
  readonly agentInfo?: Readonly<{ name?: string; version?: string }>;
  /** Vendor-declared auth methods the agent expects the client to dispatch. */
  readonly authMethods?: ReadonlyArray<{ readonly id: string; readonly description?: string }>;
}

// ---- Session -------------------------------------------------------------

export interface AcpNewSessionParams {
  readonly cwd: string;
  readonly mcpServers?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly clientCapabilities?: Readonly<Record<string, unknown>>;
}

export interface AcpNewSessionResult {
  readonly sessionId: string;
  readonly model?: string;
  readonly [k: string]: unknown;
}

export interface AcpLoadSessionParams {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly mcpServers?: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export interface AcpPromptPart {
  readonly type: string;
  readonly text?: string;
  readonly [k: string]: unknown;
}

export interface AcpPromptParams {
  readonly sessionId: string;
  readonly prompt: ReadonlyArray<AcpPromptPart>;
}

export interface AcpPromptResult {
  readonly stopReason: string;
  readonly usage?: Readonly<{
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
    readonly cachedInputTokens?: number;
    readonly [k: string]: unknown;
  }>;
  readonly [k: string]: unknown;
}

// ---- Incoming notifications / requests ----------------------------------

export interface AcpSessionUpdate {
  readonly sessionId: string;
  readonly update: Readonly<{
    readonly sessionUpdate: string;
    readonly [k: string]: unknown;
  }>;
}

export interface AcpPermissionRequestToolCall {
  readonly toolCallId?: string;
  readonly name?: string;
  readonly title?: string;
  readonly kind?: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly rawInput?: Readonly<Record<string, unknown>>;
  readonly [k: string]: unknown;
}

export interface AcpPermissionRequestOption {
  readonly optionId: string;
  readonly name?: string;
  readonly kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface AcpPermissionRequest {
  readonly sessionId: string;
  readonly toolCall: AcpPermissionRequestToolCall;
  readonly options: ReadonlyArray<AcpPermissionRequestOption>;
}

/**
 * What the adapter's permission handler returns. Matches the ACP spec's
 * `RequestPermissionOutcome`:
 *
 * - `{ outcome: "selected", optionId }` — normal allow/deny; the optionId must
 *   be one the server advertised in `options`.
 * - `{ outcome: "cancelled" }` — user/adapter refused to decide (e.g., because
 *   shutdown is happening). The server typically cancels the turn.
 */
export type AcpPermissionDecision =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };
