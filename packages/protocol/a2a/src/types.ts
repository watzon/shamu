/**
 * A2A v1.0 type surface — Agent Cards, the JSON-RPC method dictionary, and
 * the task / event / transport envelopes that make up the wire protocol.
 *
 * This is the minimal slice Shamu ships in v1:
 *
 * - `AgentCard` — the signed document every A2A agent publishes at
 *   `/.well-known/agent.json`. A card is an Ed25519-signed JSON document
 *   whose issuer DID binds to the public key the peer is allowed to sign
 *   tokens with.
 * - The five JSON-RPC methods: `tasks/send`, `tasks/sendSubscribe`,
 *   `tasks/get`, `tasks/cancel`, `tasks/pushNotification/set`.
 * - `Task`, `TaskState`, the `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`
 *   deltas streamed over SSE.
 * - `Message`, `Part` (text/file/data) as the minimal content shape.
 * - JSON-RPC 2.0 / SSE transport envelope types — mirrored from ACP's shape
 *   (same `jsonrpc: "2.0"` discipline, same id correlation).
 *
 * Style mirrors ACP: `readonly` everywhere, narrow string unions, nothing
 * `any`. Vendor-specific extensions live in `Record<string, unknown>` tails
 * on the JSON types rather than brand escapes — we propagate them verbatim.
 */

// ---- JSON-RPC 2.0 envelope ---------------------------------------------------

export type A2aJsonRpcId = string | number;

export interface A2aRequestFrame<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: A2aJsonRpcId;
  readonly method: string;
  readonly params?: TParams;
}

export interface A2aSuccessResponseFrame<TResult = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: A2aJsonRpcId;
  readonly result: TResult;
}

export interface A2aErrorResponseFrame {
  readonly jsonrpc: "2.0";
  readonly id: A2aJsonRpcId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export interface A2aNotificationFrame<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: TParams;
}

export type A2aFrame =
  | A2aRequestFrame
  | A2aSuccessResponseFrame
  | A2aErrorResponseFrame
  | A2aNotificationFrame;

/**
 * A single SSE message envelope (raw, before JSON-decoding). The A2A wire
 * format carries a JSON-RPC frame per SSE message: `event: message\ndata:
 * <json>\n\n`. We keep the envelope type around because tests assert on the
 * `event:` name.
 */
export interface A2aSseEnvelope {
  readonly event: string;
  readonly id?: string;
  readonly data: string;
}

// ---- Agent Card --------------------------------------------------------------

/**
 * JSON Web Key for the card's signing key. A2A v1 requires Ed25519, which
 * JWK encodes as `kty: "OKP"`, `crv: "Ed25519"`, `x: <base64url pubkey>`.
 */
export interface AgentCardJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}

export interface AgentCardCapabilities {
  readonly streaming: boolean;
  readonly pushNotifications: boolean;
  readonly stateTransitionHistory: boolean;
}

export interface AgentCardSkill {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly examples?: readonly string[];
}

export interface AgentCardEndpoints {
  /** HTTP base for JSON-RPC POST (e.g. `https://remote.example/a2a`). */
  readonly http: string;
  /**
   * Optional separate endpoint for SSE streaming. A2A v1 allows the server
   * to host streaming on the same path with content negotiation via
   * `Accept: text/event-stream`; when that's the case, this field is
   * omitted. Shamu's server returns the same URL for both.
   */
  readonly sse?: string;
}

/**
 * The signed Agent Card document. The signature covers the whole document
 * minus the `signature` field (canonical-JSON with alphabetized keys). The
 * issuer DID must be derivable from the `signingKeyJwk` via the `did:key`
 * method — a card whose signing key doesn't match the claimed issuer DID is
 * rejected at verification (`key-mismatch`).
 */
export interface AgentCard {
  /** DID identifying the card issuer (e.g. `did:key:z6Mk...`). */
  readonly issuerDid: string;
  /** Subject the card describes (often identical to the issuer; may differ). */
  readonly subject: string;
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  readonly capabilities: AgentCardCapabilities;
  readonly skills: readonly AgentCardSkill[];
  readonly endpoints: AgentCardEndpoints;
  readonly signingKeyJwk: AgentCardJwk;
  /** Base64url Ed25519 signature over canonical JSON of the card minus `signature`. */
  readonly signature: string;
}

// ---- Tasks -------------------------------------------------------------------

export type TaskState =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "canceled"
  | "failed"
  | "unknown";

/** A terminal state is one the task won't leave. */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "completed",
  "canceled",
  "failed",
]);

export type PartKind = "text" | "file" | "data";

export interface TextPart {
  readonly kind: "text";
  readonly text: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface FilePart {
  readonly kind: "file";
  readonly name?: string;
  readonly mimeType?: string;
  /** Either inline base64 payload or a URL reference. */
  readonly bytes?: string;
  readonly uri?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface DataPart {
  readonly kind: "data";
  readonly data: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type Part = TextPart | FilePart | DataPart;

export interface Message {
  readonly role: "user" | "agent";
  readonly parts: readonly Part[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TaskStatus {
  readonly state: TaskState;
  readonly message?: Message;
  /** ISO-8601 timestamp — when this status was observed. */
  readonly timestamp?: string;
}

export interface Artifact {
  readonly artifactId: string;
  readonly name?: string;
  readonly description?: string;
  readonly parts: readonly Part[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Task {
  readonly id: string;
  readonly sessionId?: string;
  readonly status: TaskStatus;
  readonly artifacts?: readonly Artifact[];
  readonly history?: readonly Message[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---- Streaming events (over SSE) --------------------------------------------

export interface TaskStatusUpdateEvent {
  readonly kind: "status-update";
  readonly taskId: string;
  readonly status: TaskStatus;
  /** `true` for the last event the server will send for this task. */
  readonly final: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TaskArtifactUpdateEvent {
  readonly kind: "artifact-update";
  readonly taskId: string;
  readonly artifact: Artifact;
  /** `true` if this is the final chunk for the artifact. */
  readonly lastChunk?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type TaskUpdateEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

// ---- Method dictionary ------------------------------------------------------

export interface TaskSendParams {
  /**
   * The task id. Clients mint a fresh id per new task; on resume, the same id
   * is replayed with additional `message` parts.
   */
  readonly id: string;
  readonly sessionId?: string;
  readonly message: Message;
  readonly pushNotification?: PushNotificationConfig;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TaskGetParams {
  readonly id: string;
  readonly historyLength?: number;
}

export interface TaskCancelParams {
  readonly id: string;
}

export interface PushNotificationConfig {
  readonly url: string;
  readonly token?: string;
  readonly authentication?: Readonly<{
    readonly schemes: readonly string[];
    readonly credentials?: string;
  }>;
}

export interface TaskPushNotificationSetParams {
  readonly id: string;
  readonly pushNotificationConfig: PushNotificationConfig;
}

/**
 * Shape of `params` / `result` for every A2A method Shamu implements. Both
 * sides (client + server) share this dictionary.
 */
export interface A2aMethodMap {
  readonly "tasks/send": {
    readonly params: TaskSendParams;
    readonly result: Task;
  };
  readonly "tasks/sendSubscribe": {
    readonly params: TaskSendParams;
    /** Only delivered over SSE — the POST body's `result` is empty. */
    readonly result: TaskUpdateEvent;
  };
  readonly "tasks/get": {
    readonly params: TaskGetParams;
    readonly result: Task;
  };
  readonly "tasks/cancel": {
    readonly params: TaskCancelParams;
    readonly result: Task;
  };
  readonly "tasks/pushNotification/set": {
    readonly params: TaskPushNotificationSetParams;
    readonly result: TaskPushNotificationSetParams;
  };
}

export type A2aMethodName = keyof A2aMethodMap;
