/**
 * Typed errors surfaced by the A2A client + server.
 *
 * Mirrors `@shamu/protocol-acp`'s `errors.ts`: a small, stable set of classes
 * with string `.code`s so callers can branch on failure mode without string
 * matching on `.message`. The protocol package intentionally doesn't extend
 * `ShamuError` from `@shamu/shared` — keeping it self-contained means a Phase
 * 8.C adapter integration can pick its own mapping without us dictating one.
 *
 * The class list:
 *
 * - `A2aError` — base.
 * - `A2aRpcError` — JSON-RPC 2.0 error envelope returned by the peer.
 * - `A2aTransportError` — HTTP / SSE transport failed (connection refused,
 *   non-2xx on a POST that wasn't an RPC error envelope, SSE stream broken
 *   mid-task).
 * - `A2aCardVerificationError` — an Agent Card failed signature or DID-binding
 *   checks; `reason` is the same narrow union `verifyAgentCard` returns.
 * - `A2aAuthError` — a bearer token was missing or rejected on an authed
 *   endpoint. The server emits one of these on every rejected request and the
 *   client converts a 401 response into one of these.
 */

export class A2aError extends Error {
  public readonly code: string = "a2a_error";
  public override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The remote peer returned a JSON-RPC 2.0 error envelope. `rpcCode` / `data`
 * come from the wire.
 */
export class A2aRpcError extends A2aError {
  public override readonly code = "a2a_rpc" as const;

  public readonly method: string;
  public readonly rpcCode: number;
  public readonly data: unknown;

  constructor(method: string, rpcCode: number, message: string, data: unknown) {
    super(`A2A rpc error ${rpcCode} (${method}): ${message}`);
    this.method = method;
    this.rpcCode = rpcCode;
    this.data = data;
  }
}

/**
 * HTTP / SSE transport failure. Carries an optional `httpStatus` so the caller
 * can distinguish "connection refused" (no status) from "server refused" (has
 * status).
 */
export class A2aTransportError extends A2aError {
  public override readonly code = "a2a_transport" as const;

  public readonly httpStatus?: number;

  constructor(message: string, httpStatus?: number, cause?: unknown) {
    super(message, cause);
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

export type AgentCardVerificationReason =
  | "bad-signature"
  | "untrusted-issuer"
  | "malformed-card"
  | "key-mismatch";

/**
 * Thrown (or returned, depending on the call site) when an Agent Card fails
 * verification. The `reason` enumerates the specific failure so a caller can
 * tell a tampered card apart from an unrecognized issuer.
 */
export class A2aCardVerificationError extends A2aError {
  public override readonly code = "a2a_card_verification" as const;

  public readonly reason: AgentCardVerificationReason;

  constructor(reason: AgentCardVerificationReason, message?: string) {
    super(message ?? `Agent Card verification failed: ${reason}`);
    this.reason = reason;
  }
}

export type A2aAuthReason = "missing-token" | "bad-token" | "untrusted-issuer" | "expired";

/**
 * The server rejected a bearer token. Reasons:
 *
 * - `missing-token` — `Authorization` header absent or not a Bearer scheme.
 * - `bad-token` — the JWS didn't verify (wrong signature, malformed).
 * - `untrusted-issuer` — the token's `iss` isn't in the server's trusted set
 *   and no card is known for that issuer.
 * - `expired` — `exp` claim is in the past.
 */
export class A2aAuthError extends A2aError {
  public override readonly code = "a2a_auth" as const;

  public readonly reason: A2aAuthReason;

  constructor(reason: A2aAuthReason, message?: string) {
    super(message ?? `A2A auth failed: ${reason}`);
    this.reason = reason;
  }
}
