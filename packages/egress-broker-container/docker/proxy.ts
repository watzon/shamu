/**
 * Containerized egress proxy — the inside-Docker peer of
 * `@shamu/egress-broker`'s in-process broker.
 *
 * This file intentionally does not import from the workspace. The container
 * build is standalone (no bun / pnpm link). `matchHost` + `normalizeHost`
 * below are COPIED from `packages/egress-broker/src/policy.ts` — keep them
 * in sync by hand. A divergence here means the container enforcer accepts
 * or rejects a different set of hosts than the in-process broker, which is
 * exactly what the parity suite guards against on the TS side.
 *
 * ### Policy source
 *
 * The host mounts the JSON policy at `/etc/shamu/policy.json` read-only;
 * we parse it at startup and exit non-zero on any validation error.
 *
 * ### Transport
 *
 * Identical to the in-process broker:
 *   - `CONNECT host:port` → open TCP tunnel if allowed; 403 otherwise.
 *   - Absolute-URI HTTP proxy requests → forward if allowed; 403 otherwise.
 *
 * ### Log framing
 *
 * Each decision emits one NDJSON line to stdout. The host broker tails via
 * `docker logs --follow` and reemits on the typed emitter. Shape must match
 * `PolicyEgressAllowedEvent` / `PolicyEgressDeniedEvent` from
 * `@shamu/egress-broker/types` verbatim.
 */

import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { connect as netConnect } from "node:net";

// ---------- inlined from @shamu/egress-broker/policy.ts (keep in sync) ----------

interface EgressPolicy {
  readonly defaultPolicy: "deny";
  readonly allowedHosts: readonly string[];
  readonly allowedHostSuffixes: readonly string[];
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function isValidHostname(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false;
  if (h.startsWith(".") || h.endsWith(".")) return false;
  const labels = h.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!DNS_LABEL.test(label)) return false;
  }
  return true;
}

function isValidSuffix(s: string): boolean {
  if (!s.startsWith(".")) return false;
  return isValidHostname(s.slice(1));
}

function normalizeHost(host: string): string {
  if (typeof host !== "string" || host.length === 0) return "";
  let out = host.trim().toLowerCase();
  if (out.startsWith("[") && out.endsWith("]")) {
    out = out.slice(1, -1);
  }
  if (out.endsWith(".")) out = out.slice(0, -1);
  return out;
}

function matchHost(policy: EgressPolicy, host: string): boolean {
  const target = normalizeHost(host);
  if (target.length === 0) return false;
  for (const allowed of policy.allowedHosts) {
    if (allowed === target) return true;
  }
  for (const suffix of policy.allowedHostSuffixes) {
    if (target.endsWith(suffix)) return true;
    if (target === suffix.slice(1)) return true;
  }
  return false;
}

function loadPolicy(path: string): EgressPolicy {
  const raw = readFileSync(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("policy must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.defaultPolicy !== "deny") {
    throw new Error(`defaultPolicy must be "deny"; got ${JSON.stringify(obj.defaultPolicy)}`);
  }
  const hosts: string[] = [];
  const suffixes: string[] = [];
  const rawHosts = Array.isArray(obj.allowedHosts) ? obj.allowedHosts : [];
  for (const h of rawHosts) {
    if (typeof h !== "string") throw new Error("allowedHosts entries must be strings");
    const n = h.toLowerCase();
    if (!isValidHostname(n)) throw new Error(`invalid host: ${h}`);
    if (!hosts.includes(n)) hosts.push(n);
  }
  const rawSuffixes = Array.isArray(obj.allowedHostSuffixes) ? obj.allowedHostSuffixes : [];
  for (const s of rawSuffixes) {
    if (typeof s !== "string") throw new Error("allowedHostSuffixes entries must be strings");
    const n = s.toLowerCase();
    if (!isValidSuffix(n)) throw new Error(`invalid suffix: ${s}`);
    if (!suffixes.includes(n)) suffixes.push(n);
  }
  return Object.freeze({
    defaultPolicy: "deny" as const,
    allowedHosts: Object.freeze(hosts.slice()),
    allowedHostSuffixes: Object.freeze(suffixes.slice()),
  });
}

// ---------- end inlined section ----------

interface AllowedEvent {
  type: "policy.egress_allowed";
  ts: number;
  proxyMethod: "CONNECT" | "HTTP";
  host: string;
  port: number | null;
  clientAddr?: string;
}

interface DeniedEvent {
  type: "policy.egress_denied";
  ts: number;
  proxyMethod: "CONNECT" | "HTTP";
  rawTarget: string;
  host: string;
  port: number | null;
  reason: "host_not_allowlisted" | "invalid_target" | "method_rejected";
  clientAddr?: string;
}

function emit(event: AllowedEvent | DeniedEvent): void {
  // Single-line NDJSON. process.stdout.write is synchronous on POSIX pipes
  // for small writes; Docker picks up each line immediately.
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function parseConnectTarget(raw: string): { host: string; port: number } | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
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
  const port = Number.parseInt(raw.slice(lastColon + 1), 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  if (host.length === 0) return null;
  return { host, port };
}

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

function respondDeniedHttp(res: ServerResponse, reason: string): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(403, {
    "content-type": "text/plain; charset=utf-8",
    connection: "close",
  });
  res.end(`egress denied: ${reason}\n`);
}

function respondDeniedConnect(sock: Socket, reason: string): void {
  const body = `egress denied: ${reason}\n`;
  const msg =
    `HTTP/1.1 403 Forbidden\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `Connection: close\r\n\r\n${body}`;
  try {
    sock.end(msg);
  } catch {
    // ignore
  }
}

function main(): void {
  const policyPath = process.env.SHAMU_POLICY_PATH ?? "/etc/shamu/policy.json";
  const bindHost = process.env.SHAMU_BIND_HOST ?? "0.0.0.0";
  const bindPort = Number.parseInt(process.env.SHAMU_BIND_PORT ?? "8080", 10);

  const policy = loadPolicy(policyPath);

  const server = createHttpServer();

  server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    clientSocket.on("error", () => {
      // ignore
    });
    const rawTarget = req.url ?? "";
    const clientAddr = clientSocket.remoteAddress ?? undefined;
    const parsed = parseConnectTarget(rawTarget);
    if (!parsed) {
      emit({
        type: "policy.egress_denied",
        ts: Date.now(),
        proxyMethod: "CONNECT",
        rawTarget,
        host: "",
        port: null,
        reason: "invalid_target",
        ...(clientAddr !== undefined ? { clientAddr } : {}),
      });
      respondDeniedConnect(clientSocket, "invalid_target");
      return;
    }
    if (!matchHost(policy, parsed.host)) {
      emit({
        type: "policy.egress_denied",
        ts: Date.now(),
        proxyMethod: "CONNECT",
        rawTarget,
        host: parsed.host,
        port: parsed.port,
        reason: "host_not_allowlisted",
        ...(clientAddr !== undefined ? { clientAddr } : {}),
      });
      respondDeniedConnect(clientSocket, "host_not_allowlisted");
      return;
    }
    emit({
      type: "policy.egress_allowed",
      ts: Date.now(),
      proxyMethod: "CONNECT",
      host: parsed.host,
      port: parsed.port,
      ...(clientAddr !== undefined ? { clientAddr } : {}),
    });
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
    upstream.on("error", () => {
      try {
        clientSocket.destroy();
      } catch {
        // ignore
      }
    });
    clientSocket.on("close", () => {
      try {
        upstream.destroy();
      } catch {
        // ignore
      }
    });
  });

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const rawTarget = req.url ?? "";
    const clientAddr = req.socket?.remoteAddress ?? undefined;
    const parsed = parseProxyRequestUrl(rawTarget);
    if (!parsed) {
      emit({
        type: "policy.egress_denied",
        ts: Date.now(),
        proxyMethod: "HTTP",
        rawTarget,
        host: "",
        port: null,
        reason: "invalid_target",
        ...(clientAddr !== undefined ? { clientAddr } : {}),
      });
      respondDeniedHttp(res, "invalid_target");
      return;
    }
    if (!matchHost(policy, parsed.host)) {
      emit({
        type: "policy.egress_denied",
        ts: Date.now(),
        proxyMethod: "HTTP",
        rawTarget,
        host: parsed.host,
        port: parsed.port,
        reason: "host_not_allowlisted",
        ...(clientAddr !== undefined ? { clientAddr } : {}),
      });
      respondDeniedHttp(res, "host_not_allowlisted");
      return;
    }
    emit({
      type: "policy.egress_allowed",
      ts: Date.now(),
      proxyMethod: "HTTP",
      host: parsed.host,
      port: parsed.port,
      ...(clientAddr !== undefined ? { clientAddr } : {}),
    });
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
  });

  server.on("clientError", (_err, sock) => {
    try {
      sock.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    } catch {
      // ignore
    }
  });

  // SIGTERM handler — flushes + exits cleanly so `docker stop` is quick.
  const shutdown = (): void => {
    server.close(() => {
      process.exit(0);
    });
    try {
      server.closeAllConnections?.();
    } catch {
      // ignore
    }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(bindPort, bindHost, () => {
    // Announce on stderr so the host doesn't mistake this for a decision
    // line; stdout is reserved for NDJSON events.
    process.stderr.write(`shamu-egress-proxy: listening on ${bindHost}:${bindPort}\n`);
  });
}

try {
  main();
} catch (err) {
  process.stderr.write(`shamu-egress-proxy: fatal: ${(err as Error).message}\n`);
  process.exit(1);
}
