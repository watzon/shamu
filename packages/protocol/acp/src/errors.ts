/**
 * Typed errors surfaced by the ACP client.
 *
 * We intentionally do NOT extend any Shamu-adapter-base error hierarchy here —
 * the protocol package is transport-only and must stay consumable from A2A or
 * any future non-adapter context. Each error carries a stable `.code` so
 * adapters can map to their own typed surfaces (e.g. Cursor's handle maps
 * `AcpProtocolError` → `error` `AgentEvent` with `errorCode: "acp_protocol"`).
 */

export class AcpError extends Error {
  public readonly code: string = "acp_error";
  public override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    if (cause !== undefined) this.cause = cause;
  }
}

/** A line arrived on the incoming stream that wasn't valid JSON-RPC. */
export class AcpProtocolError extends AcpError {
  public override readonly code = "acp_protocol" as const;

  /** The raw line (redaction is the caller's job). */
  public readonly raw: string;

  constructor(message: string, raw: string, cause?: unknown) {
    super(message, cause);
    this.raw = raw;
  }
}

/** An outgoing request didn't receive a response within the configured window. */
export class AcpTimeoutError extends AcpError {
  public override readonly code = "acp_timeout" as const;

  public readonly method: string;
  public readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`ACP request timed out after ${timeoutMs}ms: method=${method}`);
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The client was closed while at least one request was still in-flight. Every
 * pending request rejects with this; `close()` itself resolves successfully.
 */
export class AcpShutdownError extends AcpError {
  public override readonly code = "acp_shutdown" as const;
}

/**
 * The remote peer returned a JSON-RPC 2.0 error envelope. `rpcCode` / `data`
 * come from the wire.
 */
export class AcpRpcError extends AcpError {
  public override readonly code = "acp_rpc" as const;

  public readonly method: string;
  public readonly rpcCode: number;
  public readonly data: unknown;

  constructor(method: string, rpcCode: number, message: string, data: unknown) {
    super(`ACP rpc error ${rpcCode} (${method}): ${message}`);
    this.method = method;
    this.rpcCode = rpcCode;
    this.data = data;
  }
}
