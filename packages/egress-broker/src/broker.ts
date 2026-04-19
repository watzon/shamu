/**
 * `createEgressBroker` — a local HTTP(S) proxy that enforces an
 * `EgressPolicy`.
 *
 * ### Transport
 *
 * Shamu spawns one broker per run on a loopback port. Agent subprocesses
 * receive `HTTPS_PROXY` / `HTTP_PROXY` pointing at `http://127.0.0.1:<port>`
 * and issue:
 *
 *   - `CONNECT host:port HTTP/1.1` for every HTTPS request. We inspect the
 *     host against the policy. Allowed → open a raw TCP tunnel (no TLS
 *     termination, no MITM cert, no payload inspection — the tunnel is
 *     opaque to us). Denied → respond `403 Forbidden` and emit a
 *     `policy.egress_denied` event.
 *
 *   - Plain-HTTP request through the proxy (the request line carries the
 *     absolute URL, e.g. `GET http://example.com/ HTTP/1.1`). Allowed → we
 *     forward the request to the origin and pipe the response back.
 *     Denied → 403 + event.
 *
 * ### Why no TLS interception (v1)
 *
 * Shamu's threat model for Phase 7 is *host-level* egress control. A CONNECT
 * tunnel is sufficient to prevent a subprocess from reaching
 * `attacker.com` — the subprocess can't open the tunnel in the first place.
 * Inspecting request/response payloads would require a per-run CA, a cert
 * rotation story, and subprocess trust-store wiring — all Phase 8 work.
 *
 * ### Concurrency / liveness
 *
 * - The proxy uses Node's `http.createServer`. Allowed CONNECTs are
 *   tunneled via `net.connect` + `pipe()` in both directions.
 * - `shutdown()` closes the listening socket, destroys in-flight tunnels,
 *   and resolves once the server has fully closed. Idempotent.
 * - Errors on upstream connections, client sockets, or response pipes are
 *   swallowed after logging — the broker never crashes the supervisor.
 *
 * ### Out of scope (followups)
 *
 * - Multi-run single-broker (per-connection policy tag via `Proxy-Authorization`).
 * - Upstream-proxy chaining (corporate `HTTPS_PROXY`).
 * - Payload inspection (Phase 8 MITM enforcement).
 * - IPv6 policy semantics (today we normalize brackets but don't special-case
 *   scope-ids).
 */

import { appendFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { connect as netConnect } from "node:net";
import { matchHost } from "./policy.ts";
import type {
  EgressBrokerHandle,
  EgressBrokerOptions,
  EgressEventListener,
  EgressEventMap,
  EgressPolicy,
  PolicyEgressAllowedEvent,
  PolicyEgressDeniedEvent,
} from "./types.ts";

const DEFAULT_HOST = "127.0.0.1";

/**
 * Parse a CONNECT request target (`host:port`). Returns `null` for
 * malformed input so the caller can treat it as an invalid target.
 */
function parseConnectTarget(raw: string): { host: string; port: number } | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  // IPv6 literal with port: `[::1]:443`
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close < 0) return null;
    const host = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    if (!rest.startsWith(":")) return null;
    const port = Number.parseInt(rest.slice(1), 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return { host, port };
  }
  const lastColon = raw.lastIndexOf(":");
  if (lastColon < 0) return null;
  const host = raw.slice(0, lastColon);
  const portRaw = raw.slice(lastColon + 1);
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  if (host.length === 0) return null;
  return { host, port };
}

/**
 * Parse an absolute-form HTTP proxy request URL (`GET http://host/ HTTP/1.1`).
 * Returns `null` for malformed input.
 */
function parseProxyRequestUrl(
  raw: string | undefined,
): { host: string; port: number | null; pathname: string; search: string } | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const port = url.port === "" ? null : Number.parseInt(url.port, 10);
    if (port !== null && (!Number.isFinite(port) || port <= 0 || port > 65535)) return null;
    return {
      host: url.hostname,
      port,
      pathname: url.pathname || "/",
      search: url.search,
    };
  } catch {
    return null;
  }
}

/**
 * Internal emitter — avoids a Node `EventEmitter` dep and gives us typed
 * `on()`. Listener errors are caught so a misbehaving consumer can't take
 * down the proxy.
 */
class TypedEmitter {
  private readonly listeners = new Map<keyof EgressEventMap, Set<(ev: unknown) => void>>();

  on<K extends keyof EgressEventMap>(type: K, listener: EgressEventListener<K>): () => void {
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

  emit<K extends keyof EgressEventMap>(type: K, event: EgressEventMap[K]): void {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        // Listener is best-effort; never crash the proxy.
      }
    }
  }
}

/**
 * Create a broker handle. Call `start()` to listen; safe to spin up in the
 * same event loop as the supervised subprocess.
 */
export function createEgressBroker(opts: EgressBrokerOptions): EgressBrokerHandle {
  const host = opts.host ?? DEFAULT_HOST;
  const requestedPort = opts.port ?? 0;
  const now = opts.now ?? Date.now;
  const policy: EgressPolicy = opts.policy;
  const emitter = new TypedEmitter();

  // Track in-flight tunnels so shutdown can tear them down.
  const activeTunnels = new Set<Socket>();
  let server: Server | null = null;
  let boundPort = 0;
  let starting: Promise<void> | null = null;
  let shuttingDown: Promise<void> | null = null;

  /** Append a single JSONL audit line; swallow I/O errors. */
  async function writeAudit(
    event: PolicyEgressDeniedEvent | PolicyEgressAllowedEvent,
  ): Promise<void> {
    if (!policy.egressLogPath) return;
    try {
      await appendFile(policy.egressLogPath, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // Best-effort audit; don't surface as broker failure.
    }
  }

  function emitDeny(ev: PolicyEgressDeniedEvent): void {
    emitter.emit("policy.egress_denied", ev);
    void writeAudit(ev);
  }

  function emitAllow(ev: PolicyEgressAllowedEvent): void {
    emitter.emit("policy.egress_allowed", ev);
    void writeAudit(ev);
  }

  /**
   * Respond to a plaintext proxy request with 403. Used for both
   * invalid-target and policy-denied paths.
   */
  function respondDeniedHttp(res: ServerResponse, reason: string): void {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(403, {
      "content-type": "text/plain; charset=utf-8",
      connection: "close",
    });
    res.end(`egress denied: ${reason}\n`);
  }

  /**
   * Respond to a CONNECT with an HTTP/1.1 403 and close the socket.
   * The upstream `server.on("connect", ...)` handler owns the socket at
   * this point; we must never let it leak.
   */
  function respondDeniedConnect(clientSocket: Socket, reason: string): void {
    const body = `egress denied: ${reason}\n`;
    const msg =
      `HTTP/1.1 403 Forbidden\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n${body}`;
    // Use `end(buf)` so the body is queued with the FIN; calling
    // `destroy()` races with the flush and loses the body on the wire.
    try {
      clientSocket.end(msg);
    } catch {
      // ignore — socket may already be half-closed.
    }
  }

  function onConnect(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    // Defend against ignored backpressure on error paths.
    clientSocket.on("error", () => {
      // net error — nothing actionable at the proxy layer.
    });

    const rawTarget = req.url ?? "";
    const clientAddr = clientSocket.remoteAddress ?? undefined;
    const parsed = parseConnectTarget(rawTarget);
    if (!parsed) {
      const ev: PolicyEgressDeniedEvent = {
        type: "policy.egress_denied",
        ts: now(),
        proxyMethod: "CONNECT",
        rawTarget,
        host: "",
        port: null,
        reason: "invalid_target",
        ...(clientAddr !== undefined ? { clientAddr } : {}),
      };
      emitDeny(ev);
      respondDeniedConnect(clientSocket, "invalid_target");
      return;
    }

    if (!matchHost(policy, parsed.host)) {
      const ev: PolicyEgressDeniedEvent = {
        type: "policy.egress_denied",
        ts: now(),
        proxyMethod: "CONNECT",
        rawTarget,
        host: parsed.host,
        port: parsed.port,
        reason: "host_not_allowlisted",
        ...(clientAddr !== undefined ? { clientAddr } : {}),
      };
      emitDeny(ev);
      respondDeniedConnect(clientSocket, "host_not_allowlisted");
      return;
    }

    const allowEvent: PolicyEgressAllowedEvent = {
      type: "policy.egress_allowed",
      ts: now(),
      proxyMethod: "CONNECT",
      host: parsed.host,
      port: parsed.port,
      ...(clientAddr !== undefined ? { clientAddr } : {}),
    };
    emitAllow(allowEvent);

    // Open the upstream tunnel.
    const upstream = netConnect(parsed.port, parsed.host, () => {
      try {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      } catch {
        upstream.destroy();
        return;
      }
      if (head.length > 0) {
        try {
          upstream.write(head);
        } catch {
          upstream.destroy();
          return;
        }
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    // Track BOTH ends of the tunnel so shutdown can reap them. The HTTP
    // server loses track of the client socket once the connection is
    // upgraded to a raw CONNECT tunnel — without tracking it explicitly,
    // `server.close()` would block on an "active" socket we can't reach.
    activeTunnels.add(upstream);
    activeTunnels.add(clientSocket);
    const cleanup = (): void => {
      activeTunnels.delete(upstream);
      activeTunnels.delete(clientSocket);
    };
    upstream.on("close", cleanup);
    upstream.on("error", () => {
      try {
        clientSocket.destroy();
      } catch {
        // ignore
      }
      cleanup();
    });
    clientSocket.on("close", () => {
      try {
        upstream.destroy();
      } catch {
        // ignore
      }
      cleanup();
    });
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    // Plaintext HTTP proxy path. The request line carries an absolute URL
    // (per RFC 7230 § 5.3.2); anything else is either a direct request (not
    // addressed to us as proxy — deny) or malformed.
    const rawTarget = req.url ?? "";
    const clientAddr = req.socket?.remoteAddress ?? undefined;
    const parsed = parseProxyRequestUrl(rawTarget);
    if (!parsed) {
      const ev: PolicyEgressDeniedEvent = {
        type: "policy.egress_denied",
        ts: now(),
        proxyMethod: "HTTP",
        rawTarget,
        host: "",
        port: null,
        reason: "invalid_target",
        ...(clientAddr !== undefined ? { clientAddr } : {}),
      };
      emitDeny(ev);
      respondDeniedHttp(res, "invalid_target");
      return;
    }

    if (!matchHost(policy, parsed.host)) {
      const ev: PolicyEgressDeniedEvent = {
        type: "policy.egress_denied",
        ts: now(),
        proxyMethod: "HTTP",
        rawTarget,
        host: parsed.host,
        port: parsed.port,
        reason: "host_not_allowlisted",
        ...(clientAddr !== undefined ? { clientAddr } : {}),
      };
      emitDeny(ev);
      respondDeniedHttp(res, "host_not_allowlisted");
      return;
    }

    const allowEvent: PolicyEgressAllowedEvent = {
      type: "policy.egress_allowed",
      ts: now(),
      proxyMethod: "HTTP",
      host: parsed.host,
      port: parsed.port,
      ...(clientAddr !== undefined ? { clientAddr } : {}),
    };
    emitAllow(allowEvent);

    // Forward. We strip proxy-hop headers and re-issue the request to the
    // origin. The broker doesn't attempt to transform the payload.
    const targetPort = parsed.port ?? 80;
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const lower = k.toLowerCase();
      if (lower === "proxy-connection" || lower === "proxy-authorization") continue;
      headers[k] = v as string | string[];
    }

    const upstream = httpRequest(
      {
        host: parsed.host,
        port: targetPort,
        method: req.method,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      if (res.headersSent || res.writableEnded) {
        try {
          res.destroy();
        } catch {
          // ignore
        }
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`upstream error: ${err.message}\n`);
    });
    req.pipe(upstream);
  }

  const handle: EgressBrokerHandle = {
    get port() {
      return boundPort;
    },
    get url() {
      return boundPort > 0 ? `http://${host}:${boundPort}` : "";
    },
    get policy() {
      return policy;
    },
    on(type, listener) {
      return emitter.on(type, listener);
    },
    async start(): Promise<void> {
      if (server && boundPort > 0) return;
      if (starting) return starting;
      starting = new Promise<void>((resolve, reject) => {
        const s = createHttpServer();
        s.on("connect", onConnect);
        s.on("request", onRequest);
        s.on("clientError", (_err, sock) => {
          // Malformed proxy requests — reply 400 and close. Don't crash.
          try {
            sock.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          } catch {
            // ignore
          }
        });
        s.once("error", (err) => {
          starting = null;
          reject(err);
        });
        s.listen(requestedPort, host, () => {
          const addr = s.address();
          if (addr === null || typeof addr === "string") {
            reject(new Error(`egress broker: unexpected listen address ${String(addr)}`));
            return;
          }
          boundPort = addr.port;
          server = s;
          starting = null;
          resolve();
        });
      });
      return starting;
    },
    async shutdown(): Promise<void> {
      if (!server) {
        if (shuttingDown) return shuttingDown;
        return;
      }
      if (shuttingDown) return shuttingDown;
      const current = server;
      shuttingDown = new Promise<void>((resolve) => {
        // Destroy in-flight tunnels so `server.close()` can resolve.
        for (const sock of activeTunnels) {
          try {
            sock.destroy();
          } catch {
            // ignore
          }
        }
        activeTunnels.clear();
        current.close(() => {
          resolve();
        });
        // Close idle keep-alive sockets the HTTP path may hold.
        try {
          current.closeAllConnections?.();
        } catch {
          // ignore — older Node versions may not have this; the tunnel
          // teardown above handles the critical cases.
        }
      });
      try {
        await shuttingDown;
      } finally {
        server = null;
        boundPort = 0;
        shuttingDown = null;
      }
    },
  };

  return handle;
}
