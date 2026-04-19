/**
 * Helper for `shamu doctor`'s cloudflared tunnel-scope check.
 *
 * Purpose — surface G10: a cloudflared tunnel config that exposes anything
 * other than the Linear webhook port is a security bug. The web dashboard
 * (port 4711) must never be tunneled; neither should any other loopback
 * port.
 *
 * Resolution:
 *   1. If `$CLOUDFLARED_CONFIG_PATH` is unset → `todo` with a manual-verify
 *      hint. Most users don't run a persistent tunnel via config file.
 *   2. If set but unreadable → `fail`.
 *   3. If set and readable: pattern-match each `service:` block and assert
 *      the port number equals the expected webhook port (the
 *      `@shamu/linear-webhook` default, or `$SHAMU_LINEAR_WEBHOOK_PORT`).
 *      Any other port → `fail` listing the disallowed ports.
 *   4. If no `service:` line references a local port at all → `pass` with
 *      "no localhost services".
 *
 * Why regex and not a YAML/JSON parser?
 *   - No new deps (task constraint). cloudflared configs are shallow and
 *     well-structured; the `service:` line is the load-bearing field for
 *     G10. We intentionally reject anything we can't confidently parse so
 *     operators fall back to manual verification rather than get a false
 *     `pass`.
 *
 * The regex matches both block-mapping and flow-mapping styles:
 *   `service: http://localhost:7357`
 *   `service: http://127.0.0.1:7357`
 *   `service: "http://localhost:7357"`
 *   `service: tcp://localhost:7357`
 *
 * Non-port-scoped services (e.g. `service: http_status:404`) are ignored —
 * they can't leak a local port.
 */

import { readFileSync } from "node:fs";
import { DEFAULT_PORT, ENV_PORT } from "@shamu/linear-webhook";

const SERVICE_LINE_RE =
  /service\s*:\s*"?((?:https?|tcp):\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::(\d+))?(?:\/[^\s"]*)?)"?/gim;

export interface TunnelScopeCheckOptions {
  /** Override path — used in tests. Falls back to `$CLOUDFLARED_CONFIG_PATH`. */
  readonly configPath?: string;
  /** Expected webhook port. Defaults to env / DEFAULT_PORT. */
  readonly webhookPort?: number;
  /** Env reader (tests). */
  readonly env?: NodeJS.ProcessEnv;
  /** File reader (tests). */
  readonly readFile?: (path: string) => string;
}

export interface TunnelScopeCheckResult {
  readonly status: "pass" | "fail" | "todo";
  readonly ok: boolean;
  readonly detail: string;
}

function resolveWebhookPort(opts: TunnelScopeCheckOptions): number {
  if (typeof opts.webhookPort === "number" && opts.webhookPort > 0) return opts.webhookPort;
  const env = opts.env ?? process.env;
  const raw = env[ENV_PORT];
  if (raw && raw.length > 0) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_PORT;
}

export function tunnelScopeCheck(opts: TunnelScopeCheckOptions = {}): TunnelScopeCheckResult {
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? env.CLOUDFLARED_CONFIG_PATH;

  if (!configPath || configPath.length === 0) {
    return {
      status: "todo",
      ok: true,
      detail:
        "no CLOUDFLARED_CONFIG_PATH set; manual verify recommended when running `shamu linear tunnel`",
    };
  }

  let text: string;
  try {
    text = opts.readFile ? opts.readFile(configPath) : readFileSync(configPath, "utf8");
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      status: "fail",
      ok: false,
      detail: `cannot read ${configPath}: ${message}`,
    };
  }

  const webhookPort = resolveWebhookPort(opts);
  const seen: number[] = [];
  const offenders = new Set<number>();
  // Reset lastIndex before each run; the regex is declared with the `g` flag
  // at module scope.
  SERVICE_LINE_RE.lastIndex = 0;
  for (const match of text.matchAll(SERVICE_LINE_RE)) {
    const portPart = match[2];
    if (!portPart) continue;
    const port = Number.parseInt(portPart, 10);
    if (!Number.isFinite(port) || port <= 0) continue;
    seen.push(port);
    if (port !== webhookPort) offenders.add(port);
  }

  if (seen.length === 0) {
    return {
      status: "pass",
      ok: true,
      detail: `${configPath}: no localhost services (expected webhook port ${webhookPort})`,
    };
  }

  if (offenders.size > 0) {
    const disallowed = Array.from(offenders).sort((a, b) => a - b);
    return {
      status: "fail",
      ok: false,
      detail: `${configPath} exposes non-webhook port(s): ${disallowed.join(", ")} (expected only ${webhookPort})`,
    };
  }

  return {
    status: "pass",
    ok: true,
    detail: `${configPath}: ${seen.length} service(s) all on webhook port ${webhookPort}`,
  };
}
