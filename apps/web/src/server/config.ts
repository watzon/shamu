/**
 * Server configuration resolution.
 *
 * The web dashboard is local-only, 127.0.0.1-bound, single-user. There's no
 * secrets story; configuration is exclusively env-driven so the server can
 * boot without a config file.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_PORT = 4711;

export interface ServerConfig {
  readonly port: number;
  readonly host: "127.0.0.1";
  readonly dbPath: string;
  readonly staticDir: string;
  readonly allowedOrigins: readonly string[];
  /** Tail-poll cadence for SSE (ms). Short enough to feel live, long enough not to flood SQLite. */
  readonly tailIntervalMs: number;
  /** Max events per tail round. */
  readonly tailBatchSize: number;
}

/**
 * Resolve the SQLite database path using the same precedence the CLI's
 * `run-db.ts` helper uses:
 *   1. explicit override (arg),
 *   2. `SHAMU_STATE_DIR` env,
 *   3. `<cwd>/.shamu/state`.
 *
 * We duplicate the logic rather than importing from `@shamu/cli` — the CLI is
 * an app, not a library, and creating a dependency arrow `web → cli` would
 * inflate the build and couple surfaces.
 */
export function resolveDatabasePath(opts: { stateDir?: string; cwd?: string } = {}): string {
  const cwd = opts.cwd ?? process.cwd();
  const envStateDir = process.env.SHAMU_STATE_DIR;
  const rawStateDir = opts.stateDir ?? envStateDir ?? join(cwd, ".shamu", "state");
  const stateDir = isAbsolute(rawStateDir) ? rawStateDir : resolve(cwd, rawStateDir);
  const dbPath = join(stateDir, "shamu.db");
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  const parent = dirname(dbPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  return dbPath;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new TypeError(`SHAMU_WEB_PORT must be an integer in [1, 65535]; got ${raw}`);
  }
  return n;
}

/**
 * Build the allow-list for the `Origin` header. Both `127.0.0.1` and
 * `localhost` are acceptable; browsers normalize one or the other depending
 * on what the user typed.
 */
export function originAllowList(port: number): readonly string[] {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

export interface ResolveConfigOptions {
  readonly port?: number;
  readonly stateDir?: string;
  readonly staticDir?: string;
  readonly cwd?: string;
  readonly tailIntervalMs?: number;
  readonly tailBatchSize?: number;
}

export function resolveConfig(opts: ResolveConfigOptions = {}): ServerConfig {
  const port = opts.port ?? parsePort(process.env.SHAMU_WEB_PORT, DEFAULT_PORT);
  const dbPath = resolveDatabasePath({
    ...(opts.stateDir !== undefined ? { stateDir: opts.stateDir } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  const here = dirname(new URL(import.meta.url).pathname);
  const staticDir = opts.staticDir ?? resolve(here, "..", "..", "dist", "public");
  return {
    port,
    host: "127.0.0.1",
    dbPath,
    staticDir,
    allowedOrigins: originAllowList(port),
    tailIntervalMs: opts.tailIntervalMs ?? 250,
    tailBatchSize: opts.tailBatchSize ?? 100,
  };
}
