/**
 * `@shamu/protocol-a2a` — Agent-to-Agent (A2A) v1.0 server + client.
 *
 * Self-contained library: Signed Agent Cards (Ed25519), JSON-RPC 2.0 over
 * HTTP + SSE, bearer-token auth anchored in the card's issuer DID. Sits
 * alongside `@shamu/protocol-acp`; the supervisor / mailbox wiring is a
 * follow-on Phase 8 track (8.C or later) and intentionally out of scope here.
 *
 * ### Minimal surface
 *
 * ```ts
 * const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
 * const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
 * const issuerDid = await deriveDidKeyFromJwk({ kty: "OKP", crv: "Ed25519", x: jwk.x! });
 * const card = await signAgentCard({
 *   body: {
 *     issuerDid,
 *     subject: issuerDid,
 *     name: "remote-claude",
 *     version: "0.0.1",
 *     capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
 *     skills: [{ id: "echo", name: "Echo" }],
 *     endpoints: { http: "http://127.0.0.1:0/a2a" },
 *     signingKeyJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x! },
 *   },
 *   privateKey: keys.privateKey,
 * });
 *
 * const server = await createA2aServer({
 *   agentCard: card,
 *   privateKey: keys.privateKey,
 *   onTaskSend: async (params) => ({ id: params.id, status: { state: "completed" } }),
 *   onTaskSubscribe: async (params, ctx, emit) => {
 *     emit({ kind: "status-update", taskId: params.id, status: { state: "working" }, final: false });
 *     emit({ kind: "status-update", taskId: params.id, status: { state: "completed" }, final: true });
 *   },
 * });
 * ```
 */

export {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalJson,
  stringToUtf8,
} from "./canonical.ts";
export {
  base58btcDecode,
  base58btcEncode,
  deriveDidKeyFromJwk,
  importAgentCardJwk,
  rawPubKeyFromDidKey,
  rawPubKeyToJwk,
  type SignAgentCardOptions,
  signAgentCard,
  type VerifyAgentCardOptions,
  type VerifyAgentCardResult,
  verifyAgentCard,
} from "./cards.ts";
export {
  A2aAuthError,
  type A2aAuthReason,
  A2aCardVerificationError,
  A2aError,
  A2aRpcError,
  A2aTransportError,
  type AgentCardVerificationReason,
} from "./errors.ts";
export {
  type JwsHeader,
  type JwtClaims,
  type ParsedJws,
  parseJws,
  type SignJwsOptions,
  signJws,
  verifyJwsSignature,
} from "./jws.ts";
export {
  type A2aClient,
  type A2aRequestContext,
  type A2aServerAuthFailureEvent,
  type A2aServerEventMap,
  type A2aServerHandle,
  type A2aServerHandlers,
  type A2aServerRequestEvent,
  type A2aServerResponseEvent,
  type A2aServerTaskEndEvent,
  type A2aServerTaskStartEvent,
  type A2aServerTaskUpdateEvent,
  type CreateA2aClientOptions,
  type CreateA2aServerOptions,
  createA2aClient,
  createA2aServer,
  type FetchLike,
} from "./transport.ts";
export type {
  A2aErrorResponseFrame,
  A2aFrame,
  A2aJsonRpcId,
  A2aMethodMap,
  A2aMethodName,
  A2aNotificationFrame,
  A2aRequestFrame,
  A2aSseEnvelope,
  A2aSuccessResponseFrame,
  AgentCard,
  AgentCardCapabilities,
  AgentCardEndpoints,
  AgentCardJwk,
  AgentCardSkill,
  Artifact,
  DataPart,
  FilePart,
  Message,
  Part,
  PartKind,
  PushNotificationConfig,
  Task,
  TaskArtifactUpdateEvent,
  TaskCancelParams,
  TaskGetParams,
  TaskPushNotificationSetParams,
  TaskSendParams,
  TaskState,
  TaskStatus,
  TaskStatusUpdateEvent,
  TaskUpdateEvent,
  TextPart,
} from "./types.ts";
export { TERMINAL_TASK_STATES } from "./types.ts";
