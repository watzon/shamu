/**
 * Helper for `shamu doctor`'s webhook-server health probe.
 *
 * Strictly a *probe* — we don't spawn the webhook daemon from doctor. If
 * there's nothing listening we report `todo`, not `fail`; a long-running
 * daemon is a Phase 8.A concept and most users running `shamu doctor` won't
 * have one up.
 *
 * Resolution order for the probed port:
 *   1. explicit `opts.port`
 *   2. `$SHAMU_LINEAR_WEBHOOK_PORT` (the real webhook-server env — matches
 *      `@shamu/linear-webhook::ENV_PORT`)
 *   3. `$LINEAR_WEBHOOK_PORT` (accepted per task spec)
 *   4. `@shamu/linear-webhook::DEFAULT_PORT` (7357) — BUT only if one of
 *      the envs above was set OR we've been told to probe the default.
 *
 * The "don't probe default when no env is set" branch prevents `shamu doctor`
 * from declaring a phantom `todo` every time — if there's no env, we assume
 * "no daemon configured" and emit a neutral todo hint. If an env IS set, we
 * go ahead and probe.
 */

import { request as httpRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { DEFAULT_PORT, ENV_PORT } from "@shamu/linear-webhook";

const DEFAULT_TIMEOUT_MS = 2_000;

export interface WebhookServerCheckOptions {
  /** Explicit port override (skips env resolution). */
  readonly port?: number;
  /** Timeout for the TCP connect + HTTP GET. Default 2s. */
  readonly timeoutMs?: number;
  /** Reader for env — used in tests. */
  readonly env?: NodeJS.ProcessEnv;
  /** Host override. Default 127.0.0.1. */
  readonly host?: string;
}

export interface WebhookServerCheckResult {
  readonly status: "pass" | "fail" | "todo";
  readonly ok: boolean;
  readonly detail: string;
}

interface ResolvedPort {
  readonly port: number;
  readonly source: "explicit" | "env" | "none";
}

function resolvePort(opts: WebhookServerCheckOptions): ResolvedPort {
  if (typeof opts.port === "number" && Number.isFinite(opts.port) && opts.port > 0) {
    return { port: opts.port, source: "explicit" };
  }
  const env = opts.env ?? process.env;
  const fromShamuEnv = env[ENV_PORT];
  if (fromShamuEnv && fromShamuEnv.length > 0) {
    const n = Number.parseInt(fromShamuEnv, 10);
    if (Number.isFinite(n) && n > 0) return { port: n, source: "env" };
  }
  const fromAltEnv = env.LINEAR_WEBHOOK_PORT;
  if (fromAltEnv && fromAltEnv.length > 0) {
    const n = Number.parseInt(fromAltEnv, 10);
    if (Number.isFinite(n) && n > 0) return { port: n, source: "env" };
  }
  return { port: DEFAULT_PORT, source: "none" };
}

/** Connect to `host:port`; resolve true iff the socket reaches open state. */
function tcpConnectProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let sock: Socket | null = null;
    const settle = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.destroy();
      } catch {
        // ignore
      }
      resolve(reachable);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
    try {
      sock = netConnect({ host, port }, () => settle(true));
      sock.on("error", () => settle(false));
    } catch {
      settle(false);
    }
  });
}

interface HealthResponse {
  readonly ok: boolean;
  readonly statusCode: number;
  readonly bodyText: string;
}

function healthGet(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: true; response: HealthResponse } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (
      r: { ok: true; response: HealthResponse } | { ok: false; error: string },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        req.destroy();
      } catch {
        // ignore
      }
      resolve(r);
    };
    const timer = setTimeout(() => settle({ ok: false, error: "timeout" }), timeoutMs);
    timer.unref?.();
    const req = httpRequest(
      {
        host,
        port,
        method: "GET",
        path: "/webhooks/linear",
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          settle({
            ok: true,
            response: { ok: true, statusCode: res.statusCode ?? 0, bodyText },
          });
        });
        res.on("error", (err) => settle({ ok: false, error: err.message }));
      },
    );
    req.on("error", (err) => settle({ ok: false, error: err.message }));
    req.on("timeout", () => settle({ ok: false, error: "timeout" }));
    req.end();
  });
}

export async function webhookServerCheck(
  opts: WebhookServerCheckOptions = {},
): Promise<WebhookServerCheckResult> {
  const resolved = resolvePort(opts);
  const host = opts.host ?? "127.0.0.1";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (resolved.source === "none") {
    return {
      status: "todo",
      ok: true,
      detail:
        "no daemon detected (set SHAMU_LINEAR_WEBHOOK_PORT or LINEAR_WEBHOOK_PORT to probe a running instance)",
    };
  }

  const reachable = await tcpConnectProbe(host, resolved.port, timeoutMs);
  if (!reachable) {
    return {
      status: "todo",
      ok: true,
      detail: `no daemon listening on ${host}:${resolved.port}`,
    };
  }

  const probe = await healthGet(host, resolved.port, timeoutMs);
  if (!probe.ok) {
    return {
      status: "fail",
      ok: false,
      detail: `${host}:${resolved.port} reachable but /webhooks/linear GET failed: ${probe.error}`,
    };
  }

  const { statusCode, bodyText } = probe.response;
  if (statusCode !== 200) {
    return {
      status: "fail",
      ok: false,
      detail: `${host}:${resolved.port} /webhooks/linear returned HTTP ${statusCode}`,
    };
  }
  // Body is expected to be `{"status":"ok"}` per server.ts. We tolerate the
  // documented "ok" signal in either shape: { status: "ok" } or { ok: true }.
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return {
      status: "fail",
      ok: false,
      detail: `${host}:${resolved.port} /webhooks/linear returned non-JSON body`,
    };
  }
  const obj = parsed as Record<string, unknown>;
  const healthy = obj.status === "ok" || obj.ok === true;
  if (!healthy) {
    return {
      status: "fail",
      ok: false,
      detail: `${host}:${resolved.port} /webhooks/linear replied 200 but body was not ok: ${bodyText}`,
    };
  }
  return {
    status: "pass",
    ok: true,
    detail: `daemon ok on ${host}:${resolved.port}`,
  };
}
