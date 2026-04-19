/**
 * `@shamu/protocol-acp` — Agent Client Protocol (ACP) client library.
 *
 * JSON-RPC 2.0 method dictionary + framing + id correlation. Transport
 * agnostic: a newline-delimited stdio transport ships today; an HTTP-ACP
 * transport could drop in later. Consumed by:
 *
 * - `@shamu/adapter-cursor` (Phase 7.B)
 * - `@shamu/adapter-gemini` (Phase 7.C, reuses this projector)
 * - Potentially Phase 8's A2A bridge, if ACP-over-A2A ever lands.
 *
 * The package is vendor-agnostic: auth method names, capability flags, and
 * session-update projection live in the adapter.
 *
 * ### Surface
 *
 * ```ts
 * const transport = createStdioTransport({ binary: "/path/to/agent", args: ["acp"] });
 * const client = createAcpClient(transport);
 * client.onProtocolError((err) => log.warn(err));
 * client.onSessionUpdate((ev) => project(ev));
 * client.onPermissionRequest(async (req) => decide(req));
 * await client.initialize({ protocolVersion: 1, clientInfo: { name: "shamu" } });
 * await client.authenticate("cursor_login", { apiKey });
 * const { sessionId } = await client.newSession({ cwd });
 * const result = await client.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
 * await client.close();
 * ```
 */

export type {
  AcpClient,
  AcpClientOptions,
  AcpJsonRpcTransport,
} from "./client.ts";
export { createAcpClient } from "./client.ts";
export {
  AcpError,
  AcpProtocolError,
  AcpRpcError,
  AcpShutdownError,
  AcpTimeoutError,
} from "./errors.ts";
export { bytesToStrings, type DecodedLine, decodeFrames, encodeFrame } from "./framing.ts";
export type {
  CreateStdioTransportOptions,
  StdioSpawnLike,
} from "./transport-stdio.ts";
export { createStdioTransport } from "./transport-stdio.ts";
export type {
  AcpErrorResponseFrame,
  AcpFrame,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpJsonRpcId,
  AcpLoadSessionParams,
  AcpNewSessionParams,
  AcpNewSessionResult,
  AcpNotificationFrame,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpPermissionRequestOption,
  AcpPermissionRequestToolCall,
  AcpPromptParams,
  AcpPromptPart,
  AcpPromptResult,
  AcpRequestFrame,
  AcpSessionUpdate,
  AcpSuccessResponseFrame,
} from "./types.ts";
