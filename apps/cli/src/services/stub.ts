/**
 * StubServices — the only `Services` implementation that exists in Phase 1.D.
 *
 * `persistence` and `supervisor` are `null` (not yet wired). The logger is a
 * real `@shamu/shared/logger.Logger` (not a second duck-typed class) so the
 * integration primitives (Linear runtime, etc.) that want the concrete class
 * shape can take `services.logger` directly — see Phase 6.C.3 follow-up #3.
 */

import { createLogger, type LogEntry, type LogLevel } from "@shamu/shared/logger";
import { loadConfig } from "../config.ts";
import type { Services } from "./types.ts";

/**
 * Accepted log levels at the CLI layer. The shared logger's `LogLevel`
 * union also includes "trace", which we don't expose on the CLI `--log-level`
 * flag; the stub only forwards values that match this narrower tuple.
 */
export type CliLogLevel = "debug" | "info" | "warn" | "error";

function toSharedLevel(level: CliLogLevel): LogLevel {
  // CliLogLevel is a strict subset of the shared Logger's LogLevel.
  return level;
}

/**
 * JSONL transport for the CLI. Writes one line per entry to stderr. Matches
 * the shape the previous hand-rolled stub emitted so existing log-parsing
 * tests continue to recognise the framing: `{ ts, level, message, ...fields }`.
 */
function cliStderrTransport(entry: LogEntry): void {
  const { ts, level, msg, context } = entry;
  const line = JSON.stringify({
    ts: new Date(ts).toISOString(),
    level,
    message: msg,
    ...context,
  });
  process.stderr.write(`${line}\n`);
}

export interface StubServicesOptions {
  /** Path to a config file. Defaults to auto-discovery relative to cwd. */
  readonly configPath?: string;
  readonly cwd?: string;
  readonly logLevel?: CliLogLevel;
}

/**
 * Build a Services bundle for Phase 1.D. Loads config asynchronously and
 * returns the load Result so callers can branch on CONFIG_ERROR vs success
 * without throwing across the command boundary.
 */
export async function buildStubServices(
  options: StubServicesOptions = {},
): Promise<
  | { readonly ok: true; readonly services: Services; readonly configSource: string | null }
  | { readonly ok: false; readonly error: Error }
> {
  const loadParams: Parameters<typeof loadConfig>[0] = {};
  if (options.configPath !== undefined) loadParams.explicitPath = options.configPath;
  if (options.cwd !== undefined) loadParams.cwd = options.cwd;
  const loaded = await loadConfig(loadParams);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const logger = createLogger({
    level: toSharedLevel(options.logLevel ?? "info"),
    transport: cliStderrTransport,
  });
  const services: Services = {
    config: loaded.value,
    logger,
    persistence: null,
    supervisor: null,
  };
  return { ok: true, services, configSource: loaded.source };
}
