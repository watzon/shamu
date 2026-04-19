/**
 * Pi JSONL RPC client — thin command/response correlator over a strict
 * LF-only stdio transport.
 *
 * ### Wire shape (summarized from Pi's `rpc.md`)
 *
 * - Outgoing command: `{"id": "<string>", "type": "<command-name>", ...params}`
 * - Response:         `{"id": "<string>", "type": "response", "command": "<command-name>", "success": bool, "data"?: ..., "error"?: "..."}`
 * - Async event:      `{"type": "<event-name>", ...fields}` (no `id`)
 *
 * Pi's RPC doc does NOT specify a server-hello / `{type:"ready"}`
 * handshake; the server accepts commands immediately after start. The
 * mission brief referenced such a handshake; we handle it DEFENSIVELY —
 * if the first inbound frame is literally `{"type":"ready", ...}` we
 * consume it as a handshake via the one-shot `onReady` hook (driver uses
 * this to resolve its "handshake complete" promise). If no ready frame
 * arrives, the driver considers the subprocess ready after a short grace
 * window AND on the first successful response.
 *
 * ### Id correlation
 *
 * Every outgoing command is assigned a monotonic numeric id, stringified
 * before sending (Pi's doc uses string ids like `"req-1"` in its
 * examples). Responses match by id; a response with an unknown id fires a
 * protocol-error and is dropped.
 *
 * ### Timeouts
 *
 * Pending commands reject with `PiTimeoutError` after `commandTimeoutMs`
 * (default 60s). Long-running commands (`prompt`, `fork`) should pass a
 * larger value via `sendCommand(..., { timeoutMs })` or the driver's
 * `clientOptions.commandTimeoutMs`.
 *
 * ### Close semantics
 *
 * `close()`:
 *  1. marks the client closed so subsequent sends reject synchronously,
 *  2. tells the transport to stop,
 *  3. rejects every still-pending command with `PiShutdownError`,
 *  4. drains the consume-loop (bounded by the transport).
 */

import { PiCommandError, PiProtocolError, PiShutdownError, PiTimeoutError } from "./errors.ts";
import { encodeFrame } from "./framing.ts";

/** Transport contract the client binds against. */
export interface PiRpcTransport {
  /**
   * Send a single encoded Pi frame. Implementation applies any backpressure
   * (Node-style drain on stdin for a subprocess). Rejects if the transport
   * is already closed.
   */
  send(frame: string): Promise<void>;
  /** Incoming frames — already JSON-parsed via `framing.ts` + protocol-tolerant. */
  readonly messages: AsyncIterable<unknown>;
  /** Stop reading and release any owned resources. Idempotent. */
  close(): Promise<void>;
}

export interface PiRpcClientOptions {
  /**
   * Default timeout for a single command/response pair. Default 60_000 ms.
   */
  readonly commandTimeoutMs?: number;
  /**
   * Monotonic numeric id seed. Default 1. Exposed for tests.
   */
  readonly initialId?: number;
  /**
   * Id prefix prepended to each command id (useful when multiple clients
   * share a Pi session via forking). Default `"shamu-"`.
   */
  readonly idPrefix?: string;
}

/** Async event with no `id` — dispatched via `onEvent` subscribers. */
export interface PiAsyncEvent {
  readonly type: string;
  readonly [k: string]: unknown;
}

/** Response envelope, post-validation. */
export interface PiResponseFrame {
  readonly id: string;
  readonly type: "response";
  readonly command?: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

type EventHandler = (ev: PiAsyncEvent) => void;
type ProtocolErrorHandler = (err: PiProtocolError) => void;
type ReadyHandler = (frame: PiAsyncEvent) => void;

interface PendingCommand {
  readonly command: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface PiRpcClient {
  /**
   * Send a command + await its response. Rejects with `PiTimeoutError`,
   * `PiShutdownError`, or `PiCommandError` (when the response's
   * `success: false`).
   */
  sendCommand<T = unknown>(
    type: string,
    params?: Readonly<Record<string, unknown>>,
    opts?: { readonly timeoutMs?: number },
  ): Promise<T>;
  /**
   * Subscribe to async events (no `id`). Returns an unsubscribe function.
   */
  onEvent(handler: EventHandler): () => void;
  /**
   * Subscribe to protocol errors (malformed frames, unexpected shapes).
   * Returns an unsubscribe function.
   */
  onProtocolError(handler: ProtocolErrorHandler): () => void;
  /**
   * Subscribe to a `{type:"ready", ...}` handshake frame. Pi's documented
   * RPC protocol does not emit one today, but the mission reserves a
   * handshake-receive surface for defensive compatibility. Invoked at most
   * once per client. Returns an unsubscribe function.
   */
  onReady(handler: ReadyHandler): () => void;
  /** Close the client + transport. Idempotent. */
  close(): Promise<void>;
}

class PiRpcClientImpl implements PiRpcClient {
  private readonly transport: PiRpcTransport;
  private readonly defaultTimeoutMs: number;
  private readonly idPrefix: string;
  private nextId: number;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly protocolErrorHandlers = new Set<ProtocolErrorHandler>();
  private readyHandler: ReadyHandler | null = null;
  private readyFired = false;
  private closed = false;
  private readonly loop: Promise<void>;

  constructor(transport: PiRpcTransport, opts: PiRpcClientOptions = {}) {
    this.transport = transport;
    this.defaultTimeoutMs = opts.commandTimeoutMs ?? 60_000;
    this.nextId = opts.initialId ?? 1;
    this.idPrefix = opts.idPrefix ?? "shamu-";
    this.loop = this.consume().catch(() => {
      // consume-loop surfaces fatal transport errors via protocol-error
      // fanout + pending rejection; swallow its rejection here.
    });
  }

  sendCommand<T = unknown>(
    type: string,
    params: Readonly<Record<string, unknown>> = {},
    opts: { readonly timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new PiShutdownError("Pi RPC client is closed"));
    }
    if (typeof type !== "string" || type.length === 0) {
      return Promise.reject(new PiCommandError(type, "command type must be a non-empty string"));
    }
    const id = `${this.idPrefix}${this.nextId++}`;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const frame: Record<string, unknown> = { id, type, ...params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiTimeoutError(type, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, {
        command: type,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      const encoded = encodeFrame(frame);
      void this.transport.send(encoded).catch((cause) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(
          new PiCommandError(
            type,
            `Pi RPC transport send failed: ${(cause as Error)?.message ?? String(cause)}`,
            cause,
          ),
        );
      });
    });
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onProtocolError(handler: ProtocolErrorHandler): () => void {
    this.protocolErrorHandlers.add(handler);
    return () => this.protocolErrorHandlers.delete(handler);
  }

  onReady(handler: ReadyHandler): () => void {
    this.readyHandler = handler;
    return () => {
      if (this.readyHandler === handler) this.readyHandler = null;
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new PiShutdownError(`Pi RPC client closed while awaiting ${pending.command}`));
      this.pending.delete(id);
    }
    try {
      await this.transport.close();
    } catch {
      // best-effort
    }
    await this.loop;
  }

  private async consume(): Promise<void> {
    try {
      for await (const raw of this.transport.messages) {
        if (this.closed) break;
        this.handleFrame(raw);
      }
    } catch (cause) {
      if (this.closed) return;
      this.fireProtocolError(
        new PiProtocolError(
          `Pi RPC incoming stream errored: ${(cause as Error)?.message ?? String(cause)}`,
          "",
          cause,
        ),
      );
      this.failAllPending(
        new PiShutdownError(
          `Pi RPC transport stream errored: ${(cause as Error)?.message ?? String(cause)}`,
        ),
      );
    }
  }

  private handleFrame(raw: unknown): void {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      this.fireProtocolError(
        new PiProtocolError("Pi frame was not a JSON object", safeStringify(raw)),
      );
      return;
    }
    const frame = raw as Record<string, unknown>;
    const type = frame.type;
    if (typeof type !== "string" || type.length === 0) {
      this.fireProtocolError(
        new PiProtocolError("Pi frame missing `type` field", safeStringify(raw)),
      );
      return;
    }

    // Responses (correlated by id).
    if (type === "response") {
      this.handleResponse(frame);
      return;
    }

    // Handshake — {"type":"ready", ...}. Fire the one-shot hook and also
    // surface to event subscribers (projection will ignore it).
    if (type === "ready" && !this.readyFired) {
      this.readyFired = true;
      const handler = this.readyHandler;
      if (handler) {
        try {
          handler(frame as PiAsyncEvent);
        } catch (cause) {
          this.fireProtocolError(
            new PiProtocolError(
              `onReady handler threw: ${(cause as Error)?.message ?? String(cause)}`,
              safeStringify(frame),
              cause,
            ),
          );
        }
      }
      // Do NOT fall through to event dispatch — the handshake is consumed.
      return;
    }

    // Async event — dispatch to subscribers.
    this.dispatchEvent(frame as PiAsyncEvent);
  }

  private handleResponse(frame: Record<string, unknown>): void {
    const id = frame.id;
    if (typeof id !== "string" || id.length === 0) {
      this.fireProtocolError(
        new PiProtocolError("Pi response missing `id` field", safeStringify(frame)),
      );
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      this.fireProtocolError(
        new PiProtocolError(
          `Pi response for unknown id ${JSON.stringify(id)} (already resolved or never sent)`,
          safeStringify(frame),
        ),
      );
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    const success = frame.success;
    if (success !== true) {
      const errMsg =
        typeof frame.error === "string"
          ? (frame.error as string)
          : "Pi RPC command returned success=false";
      pending.reject(new PiCommandError(pending.command, errMsg));
      return;
    }
    pending.resolve(frame.data);
  }

  private dispatchEvent(frame: PiAsyncEvent): void {
    for (const h of this.eventHandlers) {
      try {
        h(frame);
      } catch (cause) {
        this.fireProtocolError(
          new PiProtocolError(
            `Pi event handler threw: ${(cause as Error)?.message ?? String(cause)}`,
            safeStringify(frame),
            cause,
          ),
        );
      }
    }
  }

  private fireProtocolError(err: PiProtocolError): void {
    for (const h of this.protocolErrorHandlers) {
      try {
        h(err);
      } catch {
        // swallow — handler error is not our problem to surface.
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

/** Construct a Pi RPC client over the given transport. */
export function createPiRpcClient(
  transport: PiRpcTransport,
  opts: PiRpcClientOptions = {},
): PiRpcClient {
  return new PiRpcClientImpl(transport, opts);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
