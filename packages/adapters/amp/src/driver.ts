/**
 * Amp driver — owns the long-lived `amp -x --stream-json --stream-json-input`
 * subprocess. Isolates the vendor binary behind a narrow interface the handle
 * consumes so tests can substitute a scripted double that never spawns a real
 * subprocess.
 *
 * Two drivers ship:
 *
 * 1. `createRealAmpDriver` — spawns `amp [threads continue <id>] -x
 *    --stream-json --stream-json-input` via `Bun.spawn`. Stdin stays open
 *    between turns (the long-lived subprocess decision, ratified by the
 *    user 2026-04-18). Each `send()` writes a JSON line; amp emits events on
 *    stdout. Close stdin → amp terminates after the current turn drains.
 *
 * 2. Tests pass a scripted double via `driverFactory`. See `test/harness.ts`,
 *    `test/driver.test.ts`, `test/handle.test.ts`, `test/contract.test.ts`.
 *
 * ### Vendor path resolution
 *
 * `@sourcegraph/amp` ships as an `npm install -g` dependency and places the
 * `amp` binary on `$PATH`. We do NOT take a runtime dependency on
 * `@sourcegraph/amp` (commercial license + the CLI is what users install
 * globally anyway). Resolution order:
 *
 *   1. `opts.vendorCliPath`
 *   2. `process.env.AMP_CLI_PATH`
 *   3. `Bun.which("amp")` (falls back to walking `$PATH` under non-Bun
 *      runtimes — e.g., Vitest's Node worker)
 *   4. Throw `SpawnError` with the "install with `npm install -g
 *      @sourcegraph/amp` or set AMP_CLI_PATH / vendorCliPath" guidance.
 *
 * ### Long-lived stdin
 *
 * The long-lived subprocess (user decision, 2026-04-18) keeps stdin open
 * between turns. Each `send()` calls `write(JSON.stringify(turn) + "\n")`
 * so amp sees one line-delimited turn per write. Closing stdin cleanly
 * (driver.close → writer.end) causes amp to emit its terminal `{type:"result"}`
 * and exit. The driver's `close()` is idempotent and awaits both stdin close
 * and the subprocess exit promise (best-effort).
 *
 * ### Node-drain backpressure
 *
 * Amp is a Node-based CLI. The shared `drainingWrite` helper from
 * `@shamu/adapters-base/subprocess` handles the Bun → Node fire-and-forget
 * write footgun (PLAN Phase 0.A constraint).
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  type BunFileSink,
  drainingWrite,
  killProcessGroup,
  readStreamLines,
  readStreamText,
  SpawnError,
} from "@shamu/adapters-base";

/** Narrow Bun.spawn subprocess shape the driver relies on. */
type BunSubprocess = Bun.Subprocess<"pipe", "pipe", "pipe">;

/**
 * The narrow surface the Amp handle consumes. The driver exposes
 * line-delimited stdout, stderr-as-text, and a backpressure-aware stdin
 * writer. `close()` is idempotent.
 */
export interface AmpDriver {
  /** Async-iterable of complete stdout lines (newline stripped). */
  readLines(): AsyncIterable<string>;
  /** Async-iterable of stderr chunks (decoded text). */
  readStderr(): AsyncIterable<string>;
  /** Send one raw newline-terminated line of stdin. */
  writeLine(line: string): Promise<void>;
  /**
   * Close stdin. Amp observes EOF, emits its terminal `{type:"result"}` for
   * any in-flight turn, and exits. MUST be idempotent.
   */
  closeStdin(): Promise<void>;
  /**
   * Kill the subprocess (SIGTERM). Used by the handle as a last-resort in
   * `shutdown()` if closing stdin doesn't drain the subprocess promptly.
   * MUST be idempotent.
   */
  kill(signal?: NodeJS.Signals): void;
  /**
   * Reap the subprocess + release resources. MUST be idempotent —
   * `AgentHandle.shutdown()` may be called twice in error paths.
   */
  close(): Promise<void>;
}

export interface AmpDriverOptions {
  /** Path to the `amp` binary. Override via `SpawnOpts.vendorCliPath`. */
  readonly vendorCliPath?: string;
  /** Working directory the subprocess runs in. Required. */
  readonly cwd: string;
  /**
   * Allow-listed env. If not provided, a minimal PATH/HOME passthrough is
   * applied (amp is a Node process and needs PATH + HOME to resolve its
   * own deps + keychain).
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Thread id to resume via `amp threads continue <id>`. When set, the spawn
   * command becomes `amp threads continue <id> -x --stream-json
   * --stream-json-input`. Otherwise spawn is `amp -x --stream-json
   * --stream-json-input`.
   */
  readonly resumeThreadId?: string;
  /**
   * Extra args appended after the stream-json flags. Test / debug only.
   */
  readonly extraArgs?: readonly string[];
  /** SIGKILL fallback delay after close → kill(SIGTERM). Default 2000 ms. */
  readonly sigkillTimeoutMs?: number;
  /**
   * API key to inject into the spawn env as `AMP_API_KEY`. Precedence:
   * explicit value > whatever the caller's `env` already sets > whatever
   * the current process env already has (we don't re-read). Undefined =
   * skip; user is expected to have run `amp login` (keychain-backed).
   */
  readonly apiKey?: string;
  /** Test seam — inject a spawn factory to bypass `Bun.spawn`. */
  readonly spawnFactory?: (argv: readonly string[], opts: SpawnFactoryOptions) => AmpDriver;
}

/**
 * Spawn-factory contract used by the test seam. Production code never
 * touches this; tests build their own `AmpDriver` around a scripted
 * stdout/stderr stream + in-memory stdin buffer.
 */
export interface SpawnFactoryOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly sigkillTimeoutMs: number;
}

/**
 * Resolve the vendor binary path. Exported for tests + for `shamu doctor`
 * to reuse the same search order.
 */
export function resolveAmpBinaryPath(options: {
  readonly vendorCliPath?: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Inject an alternative existence check. Defaults to `fs.existsSync`.
   * Tests pass a stub so they don't need a real binary on disk.
   */
  readonly existsImpl?: (path: string) => boolean;
  /**
   * Inject a `which`-like resolver. Defaults to a best-effort lookup that
   * prefers `Bun.which` when available, then falls back to walking `$PATH`.
   */
  readonly whichImpl?: (bin: string) => string | null;
}): string {
  const exists = options.existsImpl ?? existsSync;
  const which = options.whichImpl ?? defaultWhich;

  const explicit = options.vendorCliPath;
  if (explicit && explicit.length > 0) {
    if (exists(explicit)) return explicit;
    throw new SpawnError(
      `Amp CLI binary not found at vendorCliPath=${explicit} (file does not exist)`,
    );
  }
  const envPath = options.env?.AMP_CLI_PATH ?? process.env.AMP_CLI_PATH;
  if (envPath && envPath.length > 0) {
    if (exists(envPath)) return envPath;
    throw new SpawnError(
      `Amp CLI binary not found at AMP_CLI_PATH=${envPath} (file does not exist)`,
    );
  }
  const onPath = which("amp");
  if (onPath && onPath.length > 0 && exists(onPath)) {
    return onPath;
  }
  throw new SpawnError(
    "Amp CLI not found — install with `npm install -g @sourcegraph/amp` or set `AMP_CLI_PATH` / `vendorCliPath`.",
  );
}

/**
 * Default `which` implementation. Prefers `Bun.which` (available in Bun
 * runtimes and in the Bun-as-test-runner context); falls back to a simple
 * PATH scan so the resolver keeps working under Vitest's Node worker.
 */
function defaultWhich(bin: string): string | null {
  const bunGlobal = (globalThis as { Bun?: { which?: (b: string) => string | null } }).Bun;
  if (bunGlobal?.which) {
    try {
      const found = bunGlobal.which(bin);
      if (typeof found === "string" && found.length > 0) return found;
    } catch {
      // fall through to PATH scan
    }
  }
  const pathEnv = process.env.PATH;
  if (!pathEnv) return null;
  for (const segment of pathEnv.split(delimiter)) {
    if (segment.length === 0) continue;
    const candidate = join(segment, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Default env for the subprocess. Allow-list only keys the vendor CLI is
 * known to need. Extended by `options.env`. `AMP_API_KEY` is NOT
 * auto-injected from `process.env` — callers route that through the `apiKey`
 * option or the handle's auth path explicitly.
 */
function defaultEnv(
  extra: Readonly<Record<string, string>> | undefined,
  apiKey: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "USER", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    const v = process.env[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  // If the current process already has AMP_API_KEY set, pass it through —
  // covers CI / test-user setups where the env var is the canonical auth.
  const existingKey = process.env.AMP_API_KEY;
  if (existingKey && existingKey.length > 0) out.AMP_API_KEY = existingKey;
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  // Explicit apiKey wins over process.env + extra.
  if (apiKey && apiKey.length > 0) out.AMP_API_KEY = apiKey;
  return out;
}

/**
 * Build the argv for the `amp` subprocess. Exported for tests.
 *
 * Shape:
 *   - Spawn:  `amp -x --stream-json --stream-json-input [extraArgs...]`
 *   - Resume: `amp threads continue <id> -x --stream-json --stream-json-input [extraArgs...]`
 *
 * The `-x` flag enables non-interactive (execute) mode; `--stream-json` sets
 * the output format; `--stream-json-input` keeps stdin open for subsequent
 * turns.
 */
export function buildAmpArgv(
  binary: string,
  options: { readonly resumeThreadId?: string; readonly extraArgs?: readonly string[] },
): string[] {
  const argv: string[] = [binary];
  if (options.resumeThreadId && options.resumeThreadId.length > 0) {
    argv.push("threads", "continue", options.resumeThreadId);
  }
  argv.push("-x", "--stream-json", "--stream-json-input");
  if (options.extraArgs) {
    argv.push(...options.extraArgs);
  }
  return argv;
}

/**
 * The production driver factory. Split into a standalone export so the
 * adapter can pass it into `driverFactory` without dragging `Bun.spawn`
 * into test files.
 *
 * Construction-time failures do not leak a half-open subprocess — the
 * outer adapter's rollback path calls `close()` explicitly.
 */
export async function createRealAmpDriver(options: AmpDriverOptions): Promise<AmpDriver> {
  const binary = resolveAmpBinaryPath({
    ...(options.vendorCliPath !== undefined ? { vendorCliPath: options.vendorCliPath } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  const argv = buildAmpArgv(binary, {
    ...(options.resumeThreadId !== undefined ? { resumeThreadId: options.resumeThreadId } : {}),
    ...(options.extraArgs !== undefined ? { extraArgs: options.extraArgs } : {}),
  });
  const env = defaultEnv(options.env, options.apiKey);
  const sigkillTimeoutMs = options.sigkillTimeoutMs ?? 2000;

  if (options.spawnFactory) {
    return options.spawnFactory(argv, {
      cwd: options.cwd,
      env,
      sigkillTimeoutMs,
    });
  }

  if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
    throw new SpawnError(
      "createRealAmpDriver requires Bun.spawn; tests should inject `spawnFactory` instead",
    );
  }

  let proc: BunSubprocess;
  try {
    // Cast aligns Bun.spawn's overloaded signature with the three-pipe form.
    proc = Bun.spawn({
      cmd: argv,
      cwd: options.cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Detached so kill(-pgid) reaches any grandchildren (PLAN T13).
      detached: true,
    } as unknown as Parameters<typeof Bun.spawn>[0]) as BunSubprocess;
  } catch (cause) {
    throw new SpawnError(
      `Failed to spawn amp: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }

  const pid = proc.pid;
  if (typeof pid !== "number") {
    throw new SpawnError("Bun.spawn returned an amp subprocess without a pid");
  }

  const stdinSink = proc.stdin as unknown as BunFileSink;
  let stdinClosed = false;
  let killed = false;
  let reaped = false;

  const doCloseStdin = async (): Promise<void> => {
    if (stdinClosed) return;
    stdinClosed = true;
    try {
      await stdinSink.end?.();
    } catch {
      // ignore; stdin may already be closed.
    }
  };

  const doKill = (signal?: NodeJS.Signals): void => {
    if (killed) return;
    killed = true;
    try {
      killProcessGroup(proc, pid, true, signal ?? "SIGTERM");
    } catch {
      // best-effort
    }
  };

  return {
    readLines: () => readStreamLines(proc.stdout as ReadableStream<Uint8Array>),
    readStderr: () => readStreamText(proc.stderr as ReadableStream<Uint8Array>),
    async writeLine(line: string) {
      if (stdinClosed) {
        throw new SpawnError("AmpDriver: cannot writeLine after stdin closed");
      }
      const payload = line.endsWith("\n") ? line : `${line}\n`;
      await drainingWrite(stdinSink, payload);
    },
    closeStdin: doCloseStdin,
    kill: doKill,
    async close() {
      if (reaped) return;
      reaped = true;
      // First: close stdin so amp can drain any in-flight turn + exit cleanly.
      await doCloseStdin();
      // Give amp a window to exit; if it doesn't, SIGTERM + SIGKILL fallback.
      const exitedPromise: Promise<unknown> = proc.exited;
      let exited = false;
      try {
        await Promise.race([
          exitedPromise.then(() => {
            exited = true;
          }),
          new Promise<void>((resolve) => setTimeout(resolve, sigkillTimeoutMs)),
        ]);
      } catch {
        // ignore
      }
      if (!exited) {
        doKill("SIGTERM");
        try {
          await Promise.race([
            exitedPromise,
            new Promise<void>((resolve) => setTimeout(resolve, sigkillTimeoutMs)),
          ]);
        } catch {
          // ignore
        }
        doKill("SIGKILL");
      }
    },
  };
}
