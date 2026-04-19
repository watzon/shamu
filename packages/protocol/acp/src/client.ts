/**
 * ACP JSON-RPC 2.0 client.
 *
 * Responsibilities:
 *
 * 1. **Id correlation.** Every outgoing request gets a monotonic numeric id;
 *    responses match by id; a pending-request map keyed by id tracks the
 *    resolver + timeout timer. A response with an id we don't know drops
 *    (with a protocol-error emission) — we don't crash.
 * 2. **Request timeouts.** A pending request without a matching response
 *    within `requestTimeoutMs` rejects with `AcpTimeoutError`. Default 60s.
 *    Long-running operations (`session/prompt`) should pass a higher value
 *    or the adapter's watchdog should cancel the session out-of-band.
 * 3. **Notification dispatch.** Incoming frames with no id route to the
 *    registered handler map. `session/update` is the primary stream; the
 *    client exposes `onSessionUpdate(handler) => unsubscribe`.
 * 4. **Server-initiated requests.** A frame with an id AND a method is a
 *    request from the agent to the client — the canonical example is
 *    `session/request_permission`. The client runs its registered handler
 *    and sends a success response back with the handler's return value, OR
 *    an error response if the handler threw. Unknown server-initiated
 *    methods respond with `-32601 Method not found`.
 * 5. **Protocol-error fanout.** Every malformed inbound line fires the
 *    `onProtocolError` event without interrupting the event loop.
 * 6. **Close semantics.** `close()` (a) tells the transport to stop, (b)
 *    rejects every pending request with `AcpShutdownError`, (c) marks the
 *    client so further sends throw.
 *
 * Transport agnostic: the client consumes an `AcpJsonRpcTransport` — the
 * stdio transport is one implementation; a future HTTP-ACP transport would
 * slot in with no client-side changes.
 */

import {
  AcpError,
  AcpProtocolError,
  AcpRpcError,
  AcpShutdownError,
  AcpTimeoutError,
} from "./errors.ts";
import type {
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
  AcpPromptParams,
  AcpPromptResult,
  AcpRequestFrame,
  AcpSessionUpdate,
  AcpSuccessResponseFrame,
} from "./types.ts";

/** Transport contract the client binds against. */
export interface AcpJsonRpcTransport {
  /**
   * Send a single JSON-RPC frame. The implementation is responsible for
   * framing (newline delimiter for stdio, request body for HTTP) AND for
   * applying any required backpressure (e.g. Node-style `drain` on stdin).
   * Rejects if the transport is already closed.
   */
  send(frame: object): Promise<void>;
  /** Incoming frames, already JSON-parsed + framed. */
  readonly messages: AsyncIterable<unknown>;
  /** Stop reading and release any owned resources. Idempotent. */
  close(): Promise<void>;
}

export interface AcpClientOptions {
  /**
   * Timeout for a single request/response pair. Default 60_000 ms.
   * Long-running methods (`session/prompt`) often need a longer value; pass
   * it via `sendRequest(..., { timeoutMs })` or construct the client with a
   * larger default.
   */
  readonly requestTimeoutMs?: number;
  /**
   * Monotonic id seed. Default starts at 1. Exposed for tests.
   */
  readonly initialId?: number;
}

/** Subscriber dictionary for server-initiated requests. */
type PermissionHandler = (req: AcpPermissionRequest) => Promise<AcpPermissionDecision>;

/** Generic server-initiated request handler. */
type ServerRequestHandler = (params: unknown) => Promise<unknown>;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface AcpClient {
  // Lifecycle
  initialize(params: AcpInitializeParams): Promise<AcpInitializeResult>;
  authenticate(method: string, params?: unknown): Promise<unknown>;
  // Session
  newSession(params: AcpNewSessionParams): Promise<AcpNewSessionResult>;
  loadSession(params: AcpLoadSessionParams): Promise<void>;
  prompt(params: AcpPromptParams, opts?: { timeoutMs?: number }): Promise<AcpPromptResult>;
  cancelSession(sessionId: string): Promise<void>;
  // Incoming subscriptions
  onSessionUpdate(handler: (ev: AcpSessionUpdate) => void): () => void;
  onPermissionRequest(handler: PermissionHandler): () => void;
  onProtocolError(handler: (err: AcpProtocolError) => void): () => void;
  /**
   * Register a handler for any other server-initiated request method. Useful
   * for ACP extensions Shamu doesn't project (file/editor read-write round
   * trips, etc.). Returns an unsubscribe function.
   */
  onServerRequest(method: string, handler: ServerRequestHandler): () => void;
  // Low-level escape hatches
  sendRequest<T = unknown>(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T>;
  sendNotification(method: string, params?: unknown): void;
  // Shutdown
  close(): Promise<void>;
}

class AcpClientImpl implements AcpClient {
  private readonly transport: AcpJsonRpcTransport;
  private readonly defaultTimeoutMs: number;
  private nextId: number;
  private readonly pending = new Map<AcpJsonRpcId, PendingRequest>();
  private readonly sessionUpdateHandlers = new Set<(ev: AcpSessionUpdate) => void>();
  private readonly protocolErrorHandlers = new Set<(err: AcpProtocolError) => void>();
  private permissionHandler: PermissionHandler | null = null;
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private closed = false;
  private readonly loop: Promise<void>;

  constructor(transport: AcpJsonRpcTransport, opts: AcpClientOptions = {}) {
    this.transport = transport;
    this.defaultTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.nextId = opts.initialId ?? 1;
    this.loop = this.consume().catch(() => {
      // The consume loop surfaces fatal transport errors by failing every
      // pending request; we swallow its rejection here because the client's
      // public surface (close + in-flight requests) already delivers it.
    });
  }

  // ---- Lifecycle methods -------------------------------------------------

  initialize(params: AcpInitializeParams): Promise<AcpInitializeResult> {
    return this.sendRequest<AcpInitializeResult>("initialize", params);
  }

  authenticate(method: string, params?: unknown): Promise<unknown> {
    if (typeof method !== "string" || method.length === 0) {
      return Promise.reject(new AcpError("authenticate: method must be a non-empty string"));
    }
    return this.sendRequest("authenticate", { methodId: method, ...(asRecord(params) ?? {}) });
  }

  newSession(params: AcpNewSessionParams): Promise<AcpNewSessionResult> {
    // ACP spec requires `mcpServers` on `session/new` (empty array is valid).
    // Defaulting here so adapters that don't mediate MCP themselves still
    // produce a well-formed request. Real Cursor + Gemini ACP servers reject
    // the call with -32603 Internal Error when the field is absent.
    const wire: AcpNewSessionParams = {
      ...params,
      mcpServers: params.mcpServers ?? [],
    };
    return this.sendRequest<AcpNewSessionResult>("session/new", wire);
  }

  async loadSession(params: AcpLoadSessionParams): Promise<void> {
    const wire: AcpLoadSessionParams = {
      ...params,
      mcpServers: params.mcpServers ?? [],
    };
    await this.sendRequest("session/load", wire);
  }

  prompt(params: AcpPromptParams, opts: { timeoutMs?: number } = {}): Promise<AcpPromptResult> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return this.sendRequest<AcpPromptResult>("session/prompt", params, { timeoutMs });
  }

  async cancelSession(sessionId: string): Promise<void> {
    // Per ACP spec, session/cancel is a notification — fire-and-forget. The
    // server acknowledges by emitting a `stopReason: "cancelled"` session/update.
    this.sendNotification("session/cancel", { sessionId });
  }

  // ---- Subscription surface ---------------------------------------------

  onSessionUpdate(handler: (ev: AcpSessionUpdate) => void): () => void {
    this.sessionUpdateHandlers.add(handler);
    return () => this.sessionUpdateHandlers.delete(handler);
  }

  onPermissionRequest(handler: PermissionHandler): () => void {
    this.permissionHandler = handler;
    return () => {
      if (this.permissionHandler === handler) this.permissionHandler = null;
    };
  }

  onProtocolError(handler: (err: AcpProtocolError) => void): () => void {
    this.protocolErrorHandlers.add(handler);
    return () => this.protocolErrorHandlers.delete(handler);
  }

  onServerRequest(method: string, handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.set(method, handler);
    return () => {
      if (this.serverRequestHandlers.get(method) === handler) {
        this.serverRequestHandlers.delete(method);
      }
    };
  }

  // ---- Low-level request/notification ----------------------------------

  sendRequest<T = unknown>(
    method: string,
    params?: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new AcpShutdownError("ACP client is closed"));
    }
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const frame: AcpRequestFrame =
      params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      // Start the send; if it rejects, reject the request directly.
      void this.transport.send(frame).catch((cause) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(
          cause instanceof AcpError
            ? cause
            : new AcpError(
                `ACP transport send failed for ${method}: ${(cause as Error)?.message ?? String(cause)}`,
                cause,
              ),
        );
      });
    });
  }

  sendNotification(method: string, params?: unknown): void {
    if (this.closed) return;
    const frame: AcpNotificationFrame =
      params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
    // Notifications are fire-and-forget; transport errors surface via
    // protocol-error handlers.
    void this.transport.send(frame).catch((cause) => {
      this.fireProtocolError(
        new AcpProtocolError(
          `ACP transport send failed for notification ${method}: ${(cause as Error)?.message ?? String(cause)}`,
          "",
          cause,
        ),
      );
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Reject every pending request before closing the transport so callers
    // don't sit forever on an unresolved promise if the transport's close
    // swallows in-flight frames.
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new AcpShutdownError(`ACP client closed while awaiting ${pending.method}`));
      this.pending.delete(id);
    }
    try {
      await this.transport.close();
    } catch {
      // ignore — close is best-effort.
    }
    // Allow the consume loop to drain, but don't block indefinitely.
    await this.loop;
  }

  // ---- Inbound processing ----------------------------------------------

  private async consume(): Promise<void> {
    try {
      for await (const raw of this.transport.messages) {
        if (this.closed) break;
        this.handleFrame(raw);
      }
    } catch (cause) {
      if (this.closed) return;
      this.fireProtocolError(
        new AcpProtocolError(
          `ACP incoming stream errored: ${(cause as Error)?.message ?? String(cause)}`,
          "",
          cause,
        ),
      );
      // Reject every pending request — the transport is effectively dead.
      this.failAllPending(
        new AcpShutdownError(
          `ACP transport stream errored: ${(cause as Error)?.message ?? String(cause)}`,
        ),
      );
    }
  }

  private handleFrame(raw: unknown): void {
    if (raw === null || typeof raw !== "object") {
      this.fireProtocolError(
        new AcpProtocolError("ACP frame was not an object", safeStringify(raw)),
      );
      return;
    }
    const frame = raw as AcpFrame;
    if (!isValidJsonRpc(frame)) {
      this.fireProtocolError(
        new AcpProtocolError("ACP frame missing jsonrpc=2.0 marker", safeStringify(raw)),
      );
      return;
    }
    // Branch on the frame shape.
    if ("method" in frame && "id" in frame && frame.id !== undefined && frame.id !== null) {
      // Server-initiated request.
      void this.handleServerRequest(frame);
      return;
    }
    if ("method" in frame) {
      // Notification.
      this.handleNotification(frame);
      return;
    }
    if ("result" in frame || "error" in frame) {
      this.handleResponse(frame as AcpSuccessResponseFrame | AcpErrorResponseFrame);
      return;
    }
    this.fireProtocolError(
      new AcpProtocolError("ACP frame had no recognizable shape", safeStringify(raw)),
    );
  }

  private handleResponse(frame: AcpSuccessResponseFrame | AcpErrorResponseFrame): void {
    const id = (frame as AcpSuccessResponseFrame | AcpErrorResponseFrame).id;
    if (id === null || id === undefined) {
      this.fireProtocolError(new AcpProtocolError("ACP response missing id", safeStringify(frame)));
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      this.fireProtocolError(
        new AcpProtocolError(
          `ACP response for unknown id ${String(id)} (already resolved or never sent)`,
          safeStringify(frame),
        ),
      );
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if ("error" in frame) {
      const { code, message, data } = frame.error;
      pending.reject(new AcpRpcError(pending.method, code, message, data));
      return;
    }
    pending.resolve(frame.result);
  }

  private handleNotification(frame: AcpNotificationFrame): void {
    if (frame.method === "session/update") {
      const params = frame.params as AcpSessionUpdate | undefined;
      if (!params || typeof params !== "object") {
        this.fireProtocolError(
          new AcpProtocolError("session/update had no params", safeStringify(frame)),
        );
        return;
      }
      for (const h of this.sessionUpdateHandlers) {
        try {
          h(params);
        } catch (cause) {
          this.fireProtocolError(
            new AcpProtocolError(
              `session/update handler threw: ${(cause as Error)?.message ?? String(cause)}`,
              safeStringify(frame),
              cause,
            ),
          );
        }
      }
      return;
    }
    // Other notifications are not currently projected by Shamu; protocol-
    // error emission would be noisy, so drop silently.
  }

  private async handleServerRequest(frame: AcpRequestFrame): Promise<void> {
    const { id, method, params } = frame;
    if (method === "session/request_permission") {
      const handler = this.permissionHandler;
      if (!handler) {
        await this.respondError(id, -32601, "No permission handler registered", null);
        return;
      }
      const req = params as AcpPermissionRequest | undefined;
      if (!req || typeof req !== "object") {
        await this.respondError(id, -32602, "session/request_permission missing params", null);
        return;
      }
      try {
        const decision = await handler(req);
        await this.respondSuccess(id, { outcome: decision });
      } catch (cause) {
        await this.respondError(
          id,
          -32603,
          `permission handler threw: ${(cause as Error)?.message ?? String(cause)}`,
          null,
        );
      }
      return;
    }
    const custom = this.serverRequestHandlers.get(method);
    if (custom) {
      try {
        const result = await custom(params);
        await this.respondSuccess(id, result);
      } catch (cause) {
        await this.respondError(
          id,
          -32603,
          `server-request handler (${method}) threw: ${(cause as Error)?.message ?? String(cause)}`,
          null,
        );
      }
      return;
    }
    await this.respondError(id, -32601, `Method not found: ${method}`, null);
  }

  // ---- Response plumbing -----------------------------------------------

  private async respondSuccess(id: AcpJsonRpcId, result: unknown): Promise<void> {
    if (this.closed) return;
    const frame: AcpSuccessResponseFrame = { jsonrpc: "2.0", id, result };
    try {
      await this.transport.send(frame);
    } catch (cause) {
      this.fireProtocolError(
        new AcpProtocolError(
          `ACP response send failed: ${(cause as Error)?.message ?? String(cause)}`,
          safeStringify(frame),
          cause,
        ),
      );
    }
  }

  private async respondError(
    id: AcpJsonRpcId,
    code: number,
    message: string,
    data: unknown,
  ): Promise<void> {
    if (this.closed) return;
    const frame: AcpErrorResponseFrame = {
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== null ? { data } : {}) },
    };
    try {
      await this.transport.send(frame);
    } catch (cause) {
      this.fireProtocolError(
        new AcpProtocolError(
          `ACP error-response send failed: ${(cause as Error)?.message ?? String(cause)}`,
          safeStringify(frame),
          cause,
        ),
      );
    }
  }

  private fireProtocolError(err: AcpProtocolError): void {
    for (const h of this.protocolErrorHandlers) {
      try {
        h(err);
      } catch {
        // handler threw; swallow.
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}

export function createAcpClient(
  transport: AcpJsonRpcTransport,
  opts: AcpClientOptions = {},
): AcpClient {
  return new AcpClientImpl(transport, opts);
}

// ---- helpers -------------------------------------------------------------

function isValidJsonRpc(frame: unknown): frame is AcpFrame {
  return (
    frame !== null &&
    typeof frame === "object" &&
    (frame as { jsonrpc?: unknown }).jsonrpc === "2.0"
  );
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== "object") return null;
  return v as Record<string, unknown>;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
