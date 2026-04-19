/**
 * A2A v1 HTTP + SSE transport.
 *
 * ### Server surface
 *
 * `createA2aServer(opts)` spins up a Node HTTP server on `host:port` that
 * exposes:
 *
 * - `GET /.well-known/agent.json` — returns the signed Agent Card.
 * - `POST /a2a` — JSON-RPC 2.0 request over the HTTP body, response is a
 *   single JSON-RPC success/error frame.
 * - `POST /a2a/stream` (or `POST /a2a` with `Accept: text/event-stream`) —
 *   JSON-RPC request body, response is an SSE stream. One `event: message`
 *   line per emission, terminating when the server signals a terminal
 *   task state.
 *
 * Auth: every POST requires `Authorization: Bearer <jws>`. The server
 * parses the JWS, looks up the `iss` claim in its trusted-issuer map, and
 * verifies the signature with that issuer's stored public key. Missing /
 * malformed / unknown-issuer / expired tokens all surface as 401 with a
 * small JSON `{ error: { reason } }` body so the client can branch.
 *
 * The server handle exposes typed events:
 *   - `request` — every JSON-RPC request received (post-auth).
 *   - `response` — every JSON-RPC success/error response sent.
 *   - `task-start` — a `tasks/send` / `tasks/sendSubscribe` is about to
 *     invoke the handler.
 *   - `task-update` — the handler emitted a `TaskUpdateEvent`.
 *   - `task-end` — the task reached a terminal state or the stream ended.
 *   - `auth-failure` — a request was rejected before dispatch.
 *
 * Handlers are responsible for:
 *   - `onTaskSend(params, ctx)` → `Task` (synchronous tasks).
 *   - `onTaskSubscribe(params, ctx, emit)` → `Promise<void>` that drives the
 *     SSE stream via the `emit(ev)` callback, and resolves when the task
 *     completes.
 *   - `onTaskGet` / `onTaskCancel` / `onTaskPushNotificationSet`.
 *
 * ### Client surface
 *
 * `createA2aClient(opts)` fetches the remote Agent Card, verifies it, holds
 * the issuer's public key, and exposes:
 *
 *   - `sendTask(params)` → `Task`
 *   - `subscribeTask(params)` → `AsyncIterable<TaskUpdateEvent>`
 *   - `getTask(params)` → `Task`
 *   - `cancelTask(params)` → `Task`
 *   - `setPushNotification(params)` → `TaskPushNotificationSetParams`
 *
 * The client auto-mints a short-lived Ed25519 JWS on every POST, signed by
 * its own issuer key (`did:key:<jwk>`). The server accepts it iff the
 * client's issuer DID is in the server's trusted-issuer map (either
 * pre-seeded or added via the optional card-fetcher on first contact).
 *
 * Tokens are cached + rotated on a 5-minute clock; rotation is lazy (we
 * check before every send, mint if expiring within 60s).
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { deriveDidKeyFromJwk, importAgentCardJwk, verifyAgentCard } from "./cards.ts";
import {
  A2aAuthError,
  type A2aAuthReason,
  A2aError,
  A2aRpcError,
  A2aTransportError,
} from "./errors.ts";
import { parseJws, signJws, verifyJwsSignature } from "./jws.ts";
import type {
  A2aErrorResponseFrame,
  A2aJsonRpcId,
  A2aRequestFrame,
  A2aSuccessResponseFrame,
  AgentCard,
  AgentCardJwk,
  PushNotificationConfig,
  Task,
  TaskCancelParams,
  TaskGetParams,
  TaskPushNotificationSetParams,
  TaskSendParams,
  TaskUpdateEvent,
} from "./types.ts";
import { TERMINAL_TASK_STATES } from "./types.ts";

/**
 * Structural alias for `fetch`. We avoid `typeof fetch` so test doubles
 * don't have to imitate Bun's extra static methods (`preconnect`, etc.).
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// ---- Server ----------------------------------------------------------------

/** Context passed to every task handler. Includes caller identity. */
export interface A2aRequestContext {
  /** DID that signed the bearer token. */
  readonly callerDid: string;
  /** The raw claims from the JWS. */
  readonly claims: Readonly<Record<string, unknown>>;
}

export interface A2aServerHandlers {
  readonly onTaskSend: (params: TaskSendParams, ctx: A2aRequestContext) => Promise<Task>;
  readonly onTaskSubscribe: (
    params: TaskSendParams,
    ctx: A2aRequestContext,
    emit: (ev: TaskUpdateEvent) => void,
  ) => Promise<void>;
  readonly onTaskGet?: (params: TaskGetParams, ctx: A2aRequestContext) => Promise<Task>;
  readonly onTaskCancel?: (params: TaskCancelParams, ctx: A2aRequestContext) => Promise<Task>;
  readonly onTaskPushNotificationSet?: (
    params: TaskPushNotificationSetParams,
    ctx: A2aRequestContext,
  ) => Promise<TaskPushNotificationSetParams>;
}

export interface CreateA2aServerOptions extends A2aServerHandlers {
  readonly host?: string;
  readonly port?: number;
  readonly agentCard: AgentCard;
  /** Private key whose public counterpart is embedded in `agentCard.signingKeyJwk`. */
  readonly privateKey: CryptoKey;
  /** Issuer DIDs trusted by this server for inbound bearer tokens. */
  readonly trustedIssuers?: ReadonlySet<string>;
  /**
   * Pre-seeded mapping from issuer DID → JWK. Used to verify inbound bearer
   * tokens. When a token arrives for an issuer not in the map, the server
   * rejects with `untrusted-issuer` (TOFU-via-card-fetch is deferred to the
   * supervisor integration track; this package stays transport-only).
   */
  readonly issuerKeys?: ReadonlyMap<string, AgentCardJwk>;
  /** Clock skew tolerance in seconds for `exp`/`iat` checks. Default 30s. */
  readonly clockSkewSeconds?: number;
}

export interface A2aServerHandle {
  readonly url: string;
  readonly port: number;
  /** The card this server serves at `/.well-known/agent.json`. */
  readonly agentCard: AgentCard;
  shutdown(): Promise<void>;
  on<K extends keyof A2aServerEventMap>(
    type: K,
    listener: (ev: A2aServerEventMap[K]) => void,
  ): () => void;
}

export interface A2aServerRequestEvent {
  readonly type: "request";
  readonly method: string;
  readonly id: A2aJsonRpcId | null;
  readonly callerDid: string | null;
}

export interface A2aServerResponseEvent {
  readonly type: "response";
  readonly method: string;
  readonly id: A2aJsonRpcId | null;
  readonly ok: boolean;
}

export interface A2aServerTaskStartEvent {
  readonly type: "task-start";
  readonly taskId: string;
  readonly streaming: boolean;
  readonly callerDid: string;
}

export interface A2aServerTaskUpdateEvent {
  readonly type: "task-update";
  readonly taskId: string;
  readonly event: TaskUpdateEvent;
}

export interface A2aServerTaskEndEvent {
  readonly type: "task-end";
  readonly taskId: string;
  readonly reason: "terminal-state" | "stream-closed" | "handler-error";
}

export interface A2aServerAuthFailureEvent {
  readonly type: "auth-failure";
  readonly reason: A2aAuthReason;
  readonly httpPath: string;
}

export interface A2aServerEventMap {
  readonly request: A2aServerRequestEvent;
  readonly response: A2aServerResponseEvent;
  readonly "task-start": A2aServerTaskStartEvent;
  readonly "task-update": A2aServerTaskUpdateEvent;
  readonly "task-end": A2aServerTaskEndEvent;
  readonly "auth-failure": A2aServerAuthFailureEvent;
}

type ServerListener<K extends keyof A2aServerEventMap> = (ev: A2aServerEventMap[K]) => void;

class ServerEmitter {
  private readonly listeners = new Map<keyof A2aServerEventMap, Set<(ev: unknown) => void>>();

  on<K extends keyof A2aServerEventMap>(type: K, listener: ServerListener<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const fn = listener as (ev: unknown) => void;
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  emit<K extends keyof A2aServerEventMap>(type: K, event: A2aServerEventMap[K]): void {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        // listener misbehavior never crashes the server loop.
      }
    }
  }
}

export async function createA2aServer(opts: CreateA2aServerOptions): Promise<A2aServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const requestedPort = opts.port ?? 0;
  const emitter = new ServerEmitter();
  const clockSkewSeconds = opts.clockSkewSeconds ?? 30;
  const issuerKeyCache = new Map<string, CryptoKey>();
  const seeded = opts.issuerKeys ?? new Map<string, AgentCardJwk>();
  const trustedIssuers = opts.trustedIssuers ?? null;

  // Pre-import any seeded issuer keys to avoid rehydrating on every request.
  for (const [did, jwk] of seeded) {
    try {
      const key = await importAgentCardJwk(jwk);
      issuerKeyCache.set(did, key);
    } catch {
      // Malformed seed; skip. The request path will surface `untrusted-issuer`.
    }
  }

  // Also seed ourselves so the server accepts its own tokens (a remote may
  // call back into us using the card we published).
  try {
    const selfKey = await importAgentCardJwk(opts.agentCard.signingKeyJwk);
    issuerKeyCache.set(opts.agentCard.issuerDid, selfKey);
  } catch {
    // fall through; malformed card at this point is the caller's bug.
  }

  const server: Server = createHttpServer();
  const activeResponses = new Set<ServerResponse>();

  const authFail = (res: ServerResponse, reason: A2aAuthReason, path: string): void => {
    emitter.emit("auth-failure", { type: "auth-failure", reason, httpPath: path });
    if (!res.headersSent) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: { reason } }));
    } else {
      try {
        res.end();
      } catch {
        // already ended
      }
    }
  };

  async function verifyBearer(
    req: IncomingMessage,
    path: string,
    res: ServerResponse,
  ): Promise<A2aRequestContext | null> {
    const header = req.headers.authorization;
    if (!header || Array.isArray(header)) {
      authFail(res, "missing-token", path);
      return null;
    }
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      authFail(res, "missing-token", path);
      return null;
    }
    const token = (match[1] ?? "").trim();
    let parsed: ReturnType<typeof parseJws>;
    try {
      parsed = parseJws(token);
    } catch {
      authFail(res, "bad-token", path);
      return null;
    }
    const claims = parsed.claims;
    const iss = claims.iss;
    if (typeof iss !== "string" || iss.length === 0) {
      authFail(res, "bad-token", path);
      return null;
    }
    if (trustedIssuers && !trustedIssuers.has(iss)) {
      authFail(res, "untrusted-issuer", path);
      return null;
    }
    const key = issuerKeyCache.get(iss);
    if (!key) {
      authFail(res, "untrusted-issuer", path);
      return null;
    }
    const ok = await verifyJwsSignature(parsed, key);
    if (!ok) {
      authFail(res, "bad-token", path);
      return null;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === "number" && claims.exp + clockSkewSeconds < nowSec) {
      authFail(res, "expired", path);
      return null;
    }
    return {
      callerDid: iss,
      claims: claims as unknown as Readonly<Record<string, unknown>>,
    };
  }

  server.on("request", (req, res) => {
    activeResponses.add(res);
    res.on("close", () => activeResponses.delete(res));

    const url = new URL(req.url ?? "/", `http://${host}`);
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/.well-known/agent.json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(opts.agentCard));
      return;
    }

    if (method === "POST" && (url.pathname === "/a2a" || url.pathname === "/a2a/stream")) {
      const wantsStream =
        url.pathname === "/a2a/stream" ||
        (req.headers.accept ?? "").toLowerCase().includes("text/event-stream");
      void handleA2aPost(req, res, wantsStream, url.pathname);
      return;
    }

    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: { reason: "not-found" } }));
  });

  async function handleA2aPost(
    req: IncomingMessage,
    res: ServerResponse,
    wantsStream: boolean,
    path: string,
  ): Promise<void> {
    const ctx = await verifyBearer(req, path, res);
    if (!ctx) return;

    // Collect the full body. A2A requests are small JSON-RPC frames.
    const body = await readRequestBody(req);
    let frame: A2aRequestFrame;
    try {
      const parsed = JSON.parse(body) as unknown;
      if (!isJsonRpcRequest(parsed)) {
        throw new Error("not a JSON-RPC 2.0 request");
      }
      frame = parsed;
    } catch (cause) {
      const err: A2aErrorResponseFrame = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `parse error: ${(cause as Error)?.message ?? String(cause)}`,
        },
      };
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(err));
      return;
    }

    emitter.emit("request", {
      type: "request",
      method: frame.method,
      id: frame.id,
      callerDid: ctx.callerDid,
    });

    if (wantsStream && frame.method !== "tasks/sendSubscribe") {
      // Stream only meaningful on sendSubscribe; for others fall back to
      // non-stream semantics.
      await dispatchOneShot(frame, ctx, res);
      return;
    }
    if (frame.method === "tasks/sendSubscribe") {
      await dispatchSubscribe(frame, ctx, res);
      return;
    }
    await dispatchOneShot(frame, ctx, res);
  }

  async function dispatchOneShot(
    frame: A2aRequestFrame,
    ctx: A2aRequestContext,
    res: ServerResponse,
  ): Promise<void> {
    const respond = (payload: A2aSuccessResponseFrame | A2aErrorResponseFrame, ok: boolean) => {
      emitter.emit("response", {
        type: "response",
        method: frame.method,
        id: frame.id,
        ok,
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
    };
    try {
      switch (frame.method) {
        case "tasks/send": {
          const params = frame.params as TaskSendParams;
          emitter.emit("task-start", {
            type: "task-start",
            taskId: params.id,
            streaming: false,
            callerDid: ctx.callerDid,
          });
          const task = await opts.onTaskSend(params, ctx);
          emitter.emit("task-end", {
            type: "task-end",
            taskId: params.id,
            reason: "terminal-state",
          });
          respond({ jsonrpc: "2.0", id: frame.id, result: task }, true);
          return;
        }
        case "tasks/get": {
          if (!opts.onTaskGet) throw methodNotFound(frame.method);
          const task = await opts.onTaskGet(frame.params as TaskGetParams, ctx);
          respond({ jsonrpc: "2.0", id: frame.id, result: task }, true);
          return;
        }
        case "tasks/cancel": {
          if (!opts.onTaskCancel) throw methodNotFound(frame.method);
          const task = await opts.onTaskCancel(frame.params as TaskCancelParams, ctx);
          respond({ jsonrpc: "2.0", id: frame.id, result: task }, true);
          return;
        }
        case "tasks/pushNotification/set": {
          if (!opts.onTaskPushNotificationSet) throw methodNotFound(frame.method);
          const result = await opts.onTaskPushNotificationSet(
            frame.params as TaskPushNotificationSetParams,
            ctx,
          );
          respond({ jsonrpc: "2.0", id: frame.id, result }, true);
          return;
        }
        default:
          throw methodNotFound(frame.method);
      }
    } catch (cause) {
      const rpcCode = cause instanceof MethodNotFoundError ? -32601 : -32603;
      respond(
        {
          jsonrpc: "2.0",
          id: frame.id,
          error: {
            code: rpcCode,
            message: (cause as Error)?.message ?? String(cause),
          },
        },
        false,
      );
    }
  }

  async function dispatchSubscribe(
    frame: A2aRequestFrame,
    ctx: A2aRequestContext,
    res: ServerResponse,
  ): Promise<void> {
    const params = frame.params as TaskSendParams;
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    // Flush headers early so the client's SSE reader unblocks.
    res.flushHeaders?.();

    emitter.emit("task-start", {
      type: "task-start",
      taskId: params.id,
      streaming: true,
      callerDid: ctx.callerDid,
    });

    let ended = false;
    const endStream = (reason: A2aServerTaskEndEvent["reason"]): void => {
      if (ended) return;
      ended = true;
      emitter.emit("task-end", {
        type: "task-end",
        taskId: params.id,
        reason,
      });
      try {
        res.end();
      } catch {
        // already ended
      }
    };

    res.on("close", () => {
      if (!ended) endStream("stream-closed");
    });

    const emit = (ev: TaskUpdateEvent): void => {
      if (ended) return;
      const envelope: A2aSuccessResponseFrame<TaskUpdateEvent> = {
        jsonrpc: "2.0",
        id: frame.id,
        result: ev,
      };
      const line = `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
      try {
        res.write(line);
      } catch {
        endStream("stream-closed");
        return;
      }
      emitter.emit("task-update", {
        type: "task-update",
        taskId: params.id,
        event: ev,
      });
      if (ev.kind === "status-update" && TERMINAL_TASK_STATES.has(ev.status.state)) {
        // Leave cleanup to the handler's resolution so a handler that emits
        // a final status then resolves doesn't double-fire task-end.
      }
    };

    emitter.emit("response", {
      type: "response",
      method: frame.method,
      id: frame.id,
      ok: true,
    });

    try {
      await opts.onTaskSubscribe(params, ctx, emit);
      endStream("terminal-state");
    } catch {
      // Handler threw: emit a failed status if possible, then end.
      try {
        const failEvent: TaskUpdateEvent = {
          kind: "status-update",
          taskId: params.id,
          status: { state: "failed" },
          final: true,
        };
        const line = `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: failEvent,
        })}\n\n`;
        res.write(line);
      } catch {
        // best-effort
      }
      endStream("handler-error");
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      resolve();
    });
  });

  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new A2aError(`A2A server: unexpected listen address ${String(addr)}`);
  }
  const boundPort = addr.port;
  const boundUrl = `http://${host}:${boundPort}`;

  let shuttingDown: Promise<void> | null = null;

  const handle: A2aServerHandle = {
    get url() {
      return boundUrl;
    },
    get port() {
      return boundPort;
    },
    get agentCard() {
      return opts.agentCard;
    },
    on(type, listener) {
      return emitter.on(type, listener);
    },
    async shutdown() {
      if (shuttingDown) return shuttingDown;
      shuttingDown = new Promise<void>((resolve) => {
        for (const r of activeResponses) {
          try {
            r.end();
          } catch {
            // ignore
          }
        }
        activeResponses.clear();
        server.close(() => resolve());
        try {
          server.closeAllConnections?.();
        } catch {
          // ignore — older Node versions
        }
      });
      return shuttingDown;
    },
  };

  return handle;
}

// ---- Client ----------------------------------------------------------------

export interface CreateA2aClientOptions {
  /** URL of the remote's Agent Card (e.g. `http://host/.well-known/agent.json`). */
  readonly remoteCardUrl: string;
  /** Our own Ed25519 private key (for signing bearer JWTs). */
  readonly issuerPrivateKey: CryptoKey;
  /** DID that identifies us; MUST match the derived DID from our public JWK. */
  readonly issuerDid: string;
  /** Optional test seam for card + RPC fetch. Defaults to global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Clock override for deterministic tests. */
  readonly now?: () => number;
  /** Token TTL in seconds. Default 300 (5 min). */
  readonly tokenTtlSeconds?: number;
  /** Token rotation threshold in seconds. Default 60. */
  readonly tokenRotateWithinSeconds?: number;
}

export interface A2aClient {
  readonly remoteCard: AgentCard;
  sendTask(params: TaskSendParams): Promise<Task>;
  subscribeTask(params: TaskSendParams): Promise<AsyncIterable<TaskUpdateEvent>>;
  getTask(params: TaskGetParams): Promise<Task>;
  cancelTask(params: TaskCancelParams): Promise<Task>;
  setPushNotification(
    params: TaskPushNotificationSetParams,
  ): Promise<TaskPushNotificationSetParams>;
  close(): Promise<void>;
}

export async function createA2aClient(opts: CreateA2aClientOptions): Promise<A2aClient> {
  const fetcher: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = opts.now ?? Date.now;
  const tokenTtl = opts.tokenTtlSeconds ?? 300;
  const rotateWithin = opts.tokenRotateWithinSeconds ?? 60;

  // Fetch + verify the remote card.
  const cardRes = await fetcher(opts.remoteCardUrl, {
    method: "GET",
    headers: { accept: "application/json" },
  }).catch((cause: unknown) => {
    throw new A2aTransportError(
      `A2A client: card fetch failed: ${(cause as Error)?.message ?? String(cause)}`,
      undefined,
      cause,
    );
  });
  if (!cardRes.ok) {
    throw new A2aTransportError(
      `A2A client: card fetch returned ${cardRes.status}`,
      cardRes.status,
    );
  }
  const cardJson = (await cardRes.json()) as AgentCard;
  const verify = await verifyAgentCard({ card: cardJson });
  if (!verify.ok) {
    throw new A2aError(`A2A client: remote Agent Card invalid (${verify.reason})`);
  }

  // Sanity-check our issuer DID against our private key at construction time
  // — it's cheap and avoids mint-time failures later.
  let cachedToken: { readonly token: string; readonly expSec: number } | null = null;
  const mintToken = async (): Promise<string> => {
    const nowSec = Math.floor(now() / 1000);
    if (cachedToken && cachedToken.expSec - nowSec > rotateWithin) {
      return cachedToken.token;
    }
    const expSec = nowSec + tokenTtl;
    const token = await signJws({
      header: { alg: "EdDSA", typ: "JWT" },
      claims: {
        iss: opts.issuerDid,
        aud: cardJson.issuerDid,
        iat: nowSec,
        exp: expSec,
      },
      privateKey: opts.issuerPrivateKey,
    });
    cachedToken = { token, expSec };
    return token;
  };

  const httpBase = cardJson.endpoints.http.replace(/\/$/, "");
  const streamBase = cardJson.endpoints.sse?.replace(/\/$/, "") ?? httpBase;

  const postOnce = async <TResult>(method: string, params: unknown): Promise<TResult> => {
    const token = await mintToken();
    const id: A2aJsonRpcId = generateId();
    const body: A2aRequestFrame = { jsonrpc: "2.0", id, method, params };
    const res = await fetcher(httpBase, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    }).catch((cause: unknown) => {
      throw new A2aTransportError(
        `A2A client: POST ${method} failed: ${(cause as Error)?.message ?? String(cause)}`,
        undefined,
        cause,
      );
    });
    if (res.status === 401) {
      const reason = await extractAuthReason(res);
      throw new A2aAuthError(reason);
    }
    if (!res.ok) {
      throw new A2aTransportError(`A2A client: POST ${method} returned ${res.status}`, res.status);
    }
    const text = await res.text();
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch (cause) {
      throw new A2aTransportError(
        `A2A client: POST ${method} returned invalid JSON: ${(cause as Error)?.message}`,
        res.status,
        cause,
      );
    }
    if (isJsonRpcError(frame)) {
      throw new A2aRpcError(method, frame.error.code, frame.error.message, frame.error.data);
    }
    if (!isJsonRpcSuccess(frame)) {
      throw new A2aTransportError(`A2A client: POST ${method} returned malformed JSON-RPC frame`);
    }
    return frame.result as TResult;
  };

  const client: A2aClient = {
    remoteCard: cardJson,
    async sendTask(params) {
      return postOnce<Task>("tasks/send", params);
    },
    async subscribeTask(params) {
      const token = await mintToken();
      const id: A2aJsonRpcId = generateId();
      const body: A2aRequestFrame = {
        jsonrpc: "2.0",
        id,
        method: "tasks/sendSubscribe",
        params,
      };
      const res = await fetcher(streamBase, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      }).catch((cause: unknown) => {
        throw new A2aTransportError(
          `A2A client: subscribeTask POST failed: ${(cause as Error)?.message ?? String(cause)}`,
          undefined,
          cause,
        );
      });
      if (res.status === 401) {
        const reason = await extractAuthReason(res);
        throw new A2aAuthError(reason);
      }
      if (!res.ok) {
        throw new A2aTransportError(`A2A client: subscribeTask returned ${res.status}`, res.status);
      }
      if (!res.body) {
        throw new A2aTransportError("A2A client: subscribeTask response had no body");
      }
      return sseToTaskUpdateIterable(res.body, id);
    },
    async getTask(params) {
      return postOnce<Task>("tasks/get", params);
    },
    async cancelTask(params) {
      return postOnce<Task>("tasks/cancel", params);
    },
    async setPushNotification(params) {
      return postOnce<TaskPushNotificationSetParams>("tasks/pushNotification/set", params);
    },
    async close() {
      cachedToken = null;
    },
  };

  // Sanity-check our issuer DID matches the key (cheap; catches typos).
  try {
    const pubJwk = await crypto.subtle.exportKey("jwk", opts.issuerPrivateKey);
    if (
      pubJwk &&
      typeof pubJwk === "object" &&
      pubJwk.crv === "Ed25519" &&
      typeof pubJwk.x === "string"
    ) {
      const derived = await deriveDidKeyFromJwk({
        kty: "OKP",
        crv: "Ed25519",
        x: pubJwk.x,
      });
      if (derived !== opts.issuerDid) {
        throw new A2aError(
          `A2A client: issuerDid ${opts.issuerDid} does not match derived ${derived}`,
        );
      }
    }
  } catch (cause) {
    if (cause instanceof A2aError) throw cause;
    // Exporting a non-extractable key throws; ignore — we trust the caller.
  }

  // Suppress unused `PushNotificationConfig` import warning for consumers
  // that type `TaskPushNotificationSetParams` via a re-export:
  void (null as unknown as PushNotificationConfig);

  return client;
}

// ---- helpers ---------------------------------------------------------------

class MethodNotFoundError extends Error {}

function methodNotFound(method: string): Error {
  return new MethodNotFoundError(`Method not found: ${method}`);
}

function isJsonRpcRequest(v: unknown): v is A2aRequestFrame {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return (
    obj.jsonrpc === "2.0" &&
    typeof obj.method === "string" &&
    (typeof obj.id === "string" || typeof obj.id === "number")
  );
}

function isJsonRpcSuccess(v: unknown): v is A2aSuccessResponseFrame {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return obj.jsonrpc === "2.0" && "result" in obj && !("error" in obj);
}

function isJsonRpcError(v: unknown): v is A2aErrorResponseFrame {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  if (obj.jsonrpc !== "2.0" || !("error" in obj)) return false;
  const err = obj.error as Record<string, unknown> | undefined;
  return !!err && typeof err.code === "number" && typeof err.message === "string";
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function extractAuthReason(res: Response): Promise<A2aAuthReason> {
  try {
    const json = (await res.json()) as { error?: { reason?: string } };
    const reason = json.error?.reason;
    if (
      reason === "missing-token" ||
      reason === "bad-token" ||
      reason === "untrusted-issuer" ||
      reason === "expired"
    ) {
      return reason;
    }
  } catch {
    // best-effort
  }
  return "bad-token";
}

let nextIdSeq = 1;
function generateId(): number {
  return nextIdSeq++;
}

// ---- SSE decoding ----------------------------------------------------------

/**
 * Consume a `ReadableStream<Uint8Array>` of SSE output and yield each
 * decoded `TaskUpdateEvent`. The iterable terminates when:
 *   - a `status-update` with `final: true` is received;
 *   - the underlying stream ends;
 *   - the caller breaks the loop (the stream is released).
 *
 * We tolerate the usual SSE quirks: comment lines (`:`), empty event
 * blocks, `\r\n` line endings alongside `\n`.
 */
async function* sseToTaskUpdateIterable(
  stream: ReadableStream<Uint8Array>,
  _correlationId: A2aJsonRpcId,
): AsyncGenerator<TaskUpdateEvent, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentData: string[] = [];
  let currentEvent = "message";
  let done = false;
  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) {
        done = true;
      } else if (value) {
        buffer += decoder.decode(value, { stream: true });
      }
      // Process complete lines (terminated by \n; \r normalized).
      // An SSE event ends at a blank line.
      while (true) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length === 0) {
          if (currentData.length > 0) {
            const payload = currentData.join("\n");
            currentData = [];
            const ev = parseSseDataPayload(payload);
            if (ev) {
              yield ev;
              if (ev.kind === "status-update" && ev.final) {
                done = true;
              }
            }
          }
          currentEvent = "message";
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const rawValue = colon === -1 ? "" : line.slice(colon + 1);
        const fieldValue = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
        if (field === "data") currentData.push(fieldValue);
        else if (field === "event") currentEvent = fieldValue;
        // id / retry ignored for our purposes
      }
    }
    // Flush any trailing payload that didn't end with a blank line.
    if (currentData.length > 0) {
      const ev = parseSseDataPayload(currentData.join("\n"));
      if (ev) yield ev;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
    // Quiet unused-variable flag while keeping the param for future use.
    void currentEvent;
  }
}

function parseSseDataPayload(payload: string): TaskUpdateEvent | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).jsonrpc === "2.0" &&
      "result" in (parsed as Record<string, unknown>)
    ) {
      const result = (parsed as { result: unknown }).result;
      if (isTaskUpdateEvent(result)) return result;
    }
  } catch {
    // malformed payload; skip
  }
  return null;
}

function isTaskUpdateEvent(v: unknown): v is TaskUpdateEvent {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return obj.kind === "status-update" || obj.kind === "artifact-update";
}
