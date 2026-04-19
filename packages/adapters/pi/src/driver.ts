/**
 * Pi driver — owns the `pi --mode rpc` subprocess + RPC client. Isolates
 * the vendor binary behind a narrow interface the handle consumes so tests
 * can substitute a scripted double that never spawns a real subprocess.
 *
 * Two drivers ship:
 *
 * 1. `createRealPiDriver` — spawns `pi --mode rpc [...]` via Bun.spawn +
 *    wraps stdio with the Pi RPC framing/client. The adapter owns the
 *    subprocess lifecycle; on `close()` the driver tears down the client
 *    (which ends stdin) and reaps the process (SIGTERM then SIGKILL
 *    fallback after a short timeout).
 *
 * 2. Tests pass a scripted double via `PiAdapterOptions.driverFactory`.
 *    See `test/harness.ts`, `test/driver.test.ts`, `test/contract.test.ts`.
 *
 * ### Vendor path resolution
 *
 * Pi ships as the `pi` CLI via `npm install -g @mariozechner/pi-coding-agent`.
 * Resolution order (first hit wins):
 *
 *   1. `opts.vendorCliPath`
 *   2. `process.env.PI_CLI_PATH`
 *   3. `Bun.which("pi")`
 *
 * If none resolves, we throw `SpawnError` with the "install via npm -g
 * @mariozechner/pi-coding-agent" hint.
 *
 * ### Handshake
 *
 * Pi's current RPC doc does NOT emit a `{type:"ready"}` handshake; the
 * server accepts commands immediately. We still defensively WAIT for
 * either (a) a `{type:"ready"}` frame, OR (b) `handshakeGraceMs`
 * (default 500 ms) to elapse — whichever comes first. `handshakeTimeoutMs`
 * (default 5000 ms) caps the wait; only used if a subsequent Pi release
 * introduces a handshake that we then require.
 *
 * ### Close semantics
 *
 * `close()`:
 *  1. tells the RPC client to close (rejects pending commands),
 *  2. ends stdin (Pi treats EOF as a graceful shutdown signal),
 *  3. waits `sigkillTimeoutMs` for the subprocess to exit,
 *  4. sends SIGTERM then SIGKILL if still alive,
 *  5. awaits `proc.exited`.
 *
 * Idempotent — second call is a no-op.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable as NodeReadable } from "node:stream";
import { type PathScopeError, type ShellGateError, SpawnError } from "@shamu/adapters-base";
import type { PiProtocolError } from "./errors.ts";
import { bytesToStrings, decodeFrames } from "./framing.ts";
import { createPiRpcClient, type PiRpcClient, type PiRpcClientOptions } from "./rpc-client.ts";

// Re-export the base-package gate error types so downstream permission-handler
// consumers can import from one place.
export type { PathScopeError, ShellGateError };

/**
 * The narrow surface the handle consumes. Structurally wraps the Pi RPC
 * client + subprocess lifecycle.
 */
export interface PiDriver {
  readonly client: PiRpcClient;
  /**
   * Close the subprocess (if owned) + release the client. MUST be
   * idempotent — `AgentHandle.shutdown()` may call this twice on error.
   */
  close(): Promise<void>;
}

export interface PiDriverOptions {
  /** Path to the `pi` binary. Override via `SpawnOpts.vendorCliPath`. */
  readonly vendorCliPath?: string;
  /** Working directory the subprocess runs in. Defaults to the run's cwd. */
  readonly cwd?: string;
  /**
   * Allow-listed env. If not provided, a minimal PATH/HOME passthrough is
   * applied (Pi is a Node process + shells out to provider SDKs).
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Extra args appended after `--mode rpc`. Tests use this to pin debug flags.
   * `["--no-session"]` is auto-added when `ephemeralSession` is true.
   */
  readonly extraArgs?: readonly string[];
  /**
   * When true, spawn with `--no-session` so Pi does not persist session
   * state to disk. Default: `false` (Pi's session-on-disk is the default).
   */
  readonly ephemeralSession?: boolean;
  /** SIGKILL fallback delay; default 2000 ms. */
  readonly sigkillTimeoutMs?: number;
  /** Grace window after spawn during which we accept (but don't require) a `{type:"ready"}` frame. Default 500 ms. */
  readonly handshakeGraceMs?: number;
  /** Hard cap on the handshake wait. Default 5000 ms. */
  readonly handshakeTimeoutMs?: number;
  /** Pi RPC client options (command timeout, etc.). */
  readonly clientOptions?: PiRpcClientOptions;
  /** Protocol-error sink (e.g., route to the handle's error emitter). */
  readonly onProtocolError?: (err: PiProtocolError) => void;
  /** Stderr chunk sink (e.g., route to a logger). */
  readonly onStderr?: (chunk: string) => void;
  /** Test seam — inject an alternative spawn implementation. */
  readonly spawnImpl?: PiSpawnImpl;
}

/**
 * Subprocess shape the driver consumes. Mirrors the ACP stdio transport's
 * shape — Bun.spawn works without any adapter, Node-style drain works via
 * the FileSink's Promise-returning write, and tests substitute a fake.
 */
export interface PiSpawnLike {
  readonly stdin: {
    write(chunk: string | Uint8Array): number | Promise<number>;
    end?(): void | Promise<void>;
    flush?(): number | Promise<number>;
  };
  readonly stdout: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
  readonly stderr?: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  readonly pid?: number;
  kill(signal?: number | NodeJS.Signals): void;
}

export type PiSpawnImpl = (opts: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | undefined;
}) => PiSpawnLike;

/**
 * Resolve the vendor binary path. Exported for tests + for `shamu doctor`
 * to reuse the same search order.
 */
export function resolvePiBinaryPath(options: {
  readonly vendorCliPath?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Inject an alternative existence check. Defaults to `fs.existsSync`. */
  readonly existsImpl?: (path: string) => boolean;
  /** Inject an alternative `Bun.which`-equivalent. Defaults to `Bun.which`. */
  readonly whichImpl?: (bin: string) => string | null;
}): string {
  const exists = options.existsImpl ?? existsSync;
  // Defensive fallback — `Bun.which` is only available under Bun (it's
  // missing under Node, which vitest uses for its worker runtime). When
  // `Bun` is undefined we scan `$PATH` by hand so live smoke tests run by
  // `bun x vitest` still resolve binaries installed under `/opt/homebrew`,
  // `~/.local/bin`, etc.
  const which = options.whichImpl ?? defaultWhichImpl;

  const explicit = options.vendorCliPath;
  if (explicit && explicit.length > 0) {
    if (exists(explicit)) return explicit;
    throw new SpawnError(`Pi CLI not found at vendorCliPath=${explicit} (file does not exist)`);
  }
  const envPath = options.env?.PI_CLI_PATH ?? process.env.PI_CLI_PATH;
  if (envPath && envPath.length > 0) {
    if (exists(envPath)) return envPath;
    throw new SpawnError(`Pi CLI not found at PI_CLI_PATH=${envPath} (file does not exist)`);
  }
  const onPath = which("pi");
  if (onPath && onPath.length > 0 && exists(onPath)) return onPath;
  throw new SpawnError(
    "Pi CLI not found — install with `npm install -g @mariozechner/pi-coding-agent` or set `PI_CLI_PATH` / `vendorCliPath`",
  );
}

/**
 * Default `which` implementation. Prefers `Bun.which` (instant under the
 * Bun runtime, which `shamu` always uses in production), falls back to a
 * `$PATH` scan when running under Node (vitest workers). The fallback
 * shape mirrors `@shamu/adapters-base/vendor-cli-resolver`'s `defaultWhich`
 * so descriptors and adapter-local resolution behave identically.
 */
function defaultWhichImpl(bin: string): string | null {
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
 * Default env for the Pi subprocess. Allow-list the keys Pi / its provider
 * SDKs are known to need. Extended by `options.env`. Provider API keys
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) are explicitly forwarded since
 * Pi reads them at provider-SDK time.
 */
function defaultEnv(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const base = [
    "PATH",
    "HOME",
    "LANG",
    "USER",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
  ];
  const providerKeys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_AI_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
  ];
  for (const k of [...base, ...providerKeys]) {
    const v = process.env[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

/**
 * The production driver factory. Split into a standalone export so the
 * adapter can pass it into `driverFactory` without dragging the subprocess
 * import into test files.
 *
 * On construction:
 *  1. Resolve the vendor binary path (throws `SpawnError` if missing).
 *  2. Spawn `pi --mode rpc [--no-session] [extraArgs]`.
 *  3. Wire framing + RPC client over stdin/stdout.
 *  4. Wait for `{type:"ready"}` OR `handshakeGraceMs` to elapse (whichever
 *     comes first), capped by `handshakeTimeoutMs`.
 *  5. Return a `PiDriver` whose `close()` reaps the subprocess.
 *
 * Construction-time failures do not leak a half-open transport — the
 * outer adapter's rollback path calls `close()` explicitly.
 */
export async function createRealPiDriver(options: PiDriverOptions): Promise<PiDriver> {
  const binary = resolvePiBinaryPath({
    ...(options.vendorCliPath !== undefined ? { vendorCliPath: options.vendorCliPath } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  const args: string[] = [
    "--mode",
    "rpc",
    ...(options.ephemeralSession ? ["--no-session"] : []),
    ...(options.extraArgs ?? []),
  ];
  const env = defaultEnv(options.env);
  const spawnImpl = options.spawnImpl ?? defaultSpawnImpl;
  const sigkillTimeoutMs = options.sigkillTimeoutMs ?? 2_000;
  const handshakeGraceMs = options.handshakeGraceMs ?? 500;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;

  let proc: PiSpawnLike;
  try {
    proc = spawnImpl({ binary, args, env, cwd: options.cwd });
  } catch (cause) {
    throw new SpawnError(
      `Failed to spawn pi --mode rpc: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }

  let closed = false;
  const transport = makeTransport(proc, options.onProtocolError);
  if (options.onStderr && proc.stderr) {
    void pumpStderr(proc.stderr, options.onStderr).catch(() => {
      // best-effort
    });
  }

  let client: PiRpcClient;
  try {
    client = createPiRpcClient(transport, options.clientOptions ?? {});
  } catch (cause) {
    // Reap first so stdout closes; then close the transport; don't await
    // a client loop we never successfully started.
    try {
      await reapSubprocess(proc, sigkillTimeoutMs);
    } catch {
      // ignore
    }
    try {
      await transport.close();
    } catch {
      // ignore
    }
    throw new SpawnError(
      `Failed to initialize Pi RPC client: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }

  // Handshake wait: complete when either a ready frame arrives or the grace
  // window elapses, capped by handshakeTimeoutMs.
  try {
    await waitForHandshake(client, handshakeGraceMs, handshakeTimeoutMs, proc);
  } catch (cause) {
    // Reap first so stdout closes and the client's consume loop can drain.
    try {
      await reapSubprocess(proc, sigkillTimeoutMs);
    } catch {
      // ignore
    }
    try {
      await client.close();
    } catch {
      // ignore
    }
    throw new SpawnError(
      `Pi handshake failed: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }

  return {
    client,
    async close() {
      if (closed) return;
      closed = true;
      // Order matters: end stdin FIRST so Pi sees EOF and begins to shut
      // down gracefully. Then reap the subprocess (SIGTERM+SIGKILL
      // fallback). This closes stdout, which terminates the client's
      // consume loop. Finally close the client so its in-flight pending
      // commands reject with PiShutdownError and the loop awaits
      // complete. Doing `client.close()` FIRST would block indefinitely
      // because the consume loop is parked on a `for await` over a
      // stdout stream that hasn't yet closed.
      try {
        await proc.stdin.end?.();
      } catch {
        // ignore
      }
      await reapSubprocess(proc, sigkillTimeoutMs);
      try {
        await client.close();
      } catch {
        // best-effort — client.close() is best-effort itself.
      }
    },
  };
}

async function waitForHandshake(
  client: PiRpcClient,
  graceMs: number,
  hardCapMs: number,
  proc: PiSpawnLike,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    // (1) Handshake frame path.
    const off = client.onReady(() => {
      settle(resolve);
    });

    // (2) Grace-period path — Pi's documented protocol has no ready frame,
    // so we consider the server ready after a short wait.
    const graceTimer = setTimeout(() => {
      settle(() => {
        off();
        resolve();
      });
    }, graceMs);

    // (3) Hard-cap path — never wait longer than handshakeTimeoutMs.
    const hardCapTimer = setTimeout(() => {
      settle(() => {
        off();
        clearTimeout(graceTimer);
        reject(new Error(`Pi handshake timed out after ${hardCapMs}ms`));
      });
    }, hardCapMs);

    // (4) Early subprocess exit — Pi crashed before we could talk to it.
    void proc.exited
      .then((code) => {
        settle(() => {
          off();
          clearTimeout(graceTimer);
          clearTimeout(hardCapTimer);
          reject(new Error(`Pi subprocess exited during handshake with code=${String(code)}`));
        });
      })
      .catch(() => {
        // ignore — the grace / hard-cap timers cover us.
      });
  });
}

function makeTransport(
  proc: PiSpawnLike,
  onProtocolError: ((err: PiProtocolError) => void) | undefined,
): import("./rpc-client.ts").PiRpcTransport {
  const byteStream = toAsyncIterable(proc.stdout);
  const stringStream = bytesToStrings(byteStream);
  const decoder = decodeFrames(stringStream);

  async function* drain(): AsyncIterable<unknown> {
    for await (const line of decoder) {
      if (line.kind === "frame") {
        yield line.frame;
        continue;
      }
      if (onProtocolError) {
        try {
          onProtocolError(line.error);
        } catch {
          // swallow
        }
      }
    }
  }

  const messages = drain();
  let transportClosed = false;

  return {
    async send(frame: string): Promise<void> {
      if (transportClosed) {
        throw new Error("Pi RPC transport is closed");
      }
      const buf = new TextEncoder().encode(frame);
      try {
        const r = proc.stdin.write(buf);
        if (typeof r === "number") return;
        await r;
      } catch (cause) {
        throw new Error(
          `Pi RPC transport write failed: ${(cause as Error)?.message ?? String(cause)}`,
          { cause },
        );
      }
    },
    messages,
    async close() {
      if (transportClosed) return;
      transportClosed = true;
      try {
        // End stdin so Pi sees EOF and closes stdout.
        await proc.stdin.end?.();
      } catch {
        // ignore
      }
    },
  };
}

async function reapSubprocess(proc: PiSpawnLike, sigkillTimeoutMs: number): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    // already dead
  }
  const result = await Promise.race<"exited" | "timeout">([
    proc.exited.then(() => "exited" as const).catch(() => "exited" as const),
    new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), sigkillTimeoutMs);
    }),
  ]);
  if (result === "timeout") {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    try {
      await proc.exited;
    } catch {
      // ignore
    }
  }
}

async function pumpStderr(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  onStderr: (chunk: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const it = toAsyncIterable(stream);
  for await (const chunk of it) {
    const text = decoder.decode(chunk, { stream: true });
    if (text.length > 0) onStderr(text);
  }
  const tail = decoder.decode();
  if (tail.length > 0) onStderr(tail);
}

function toAsyncIterable(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in stream) {
    return stream as AsyncIterable<Uint8Array>;
  }
  return readableStreamToAsyncIterable(stream as ReadableStream<Uint8Array>);
}

async function* readableStreamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, unknown> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

/**
 * Default production spawn: `Bun.spawn` when running under Bun, with a
 * `node:child_process` fallback for runtimes that lack the Bun global
 * (Node-under-vitest when executing `bun x vitest run --config
 * vitest.live.config.ts`). The Node path is solely a live-smoke aid —
 * real production callers always run under Bun. Adapters with stricter
 * needs can inject `spawnImpl`.
 */
function defaultSpawnImpl(opts: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | undefined;
}): PiSpawnLike {
  if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
    const proc = Bun.spawn({
      cmd: [opts.binary, ...opts.args],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: { ...opts.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    } as unknown as Parameters<typeof Bun.spawn>[0]) as unknown as {
      stdin: PiSpawnLike["stdin"];
      stdout: ReadableStream<Uint8Array>;
      stderr: ReadableStream<Uint8Array>;
      exited: Promise<number | null>;
      pid?: number;
      kill(signal?: number | NodeJS.Signals): void;
    };
    const result: PiSpawnLike = {
      stdin: proc.stdin,
      stdout: proc.stdout,
      ...(proc.stderr ? { stderr: proc.stderr } : {}),
      exited: proc.exited,
      ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
      kill: (signal) => proc.kill(signal),
    };
    return result;
  }
  return spawnViaNode(opts);
}

/**
 * `node:child_process.spawn`-backed fallback for vitest's Node worker.
 * Maps Node's `Readable` / `Writable` surfaces onto `PiSpawnLike`:
 *
 *   - `stdin` → Promise-returning `write` (honours backpressure via `drain`),
 *     `end()`, and `flush()` no-op.
 *   - `stdout` / `stderr` → `AsyncIterable<Uint8Array>` via
 *     `Readable.toWeb().getReader()`.
 *   - `exited` → Promise resolving with the exit code.
 *   - `kill(signal)` → `proc.kill(signal)`.
 *
 * Kept out of the Bun branch to avoid dragging `node:child_process` onto
 * the hot path in production.
 */
function spawnViaNode(opts: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | undefined;
}): PiSpawnLike {
  const proc = nodeSpawn(opts.binary, [...opts.args], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    env: { ...opts.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdinStream = proc.stdin;
  if (!stdinStream) {
    throw new Error("spawnViaNode: child process is missing stdin pipe");
  }
  const stdin: PiSpawnLike["stdin"] = {
    write(chunk: string | Uint8Array): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        const ok = stdinStream.write(chunk, (err) => {
          if (err) reject(err);
        });
        const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
        if (ok) {
          resolve(size);
          return;
        }
        stdinStream.once("drain", () => resolve(size));
      });
    },
    end(): Promise<void> {
      return new Promise<void>((resolve) => {
        stdinStream.end(() => resolve());
      });
    },
  };

  async function* streamToAsyncIterable(
    stream: NodeReadable,
  ): AsyncGenerator<Uint8Array, void, unknown> {
    for await (const chunk of stream) {
      yield typeof chunk === "string" ? new TextEncoder().encode(chunk) : (chunk as Uint8Array);
    }
  }

  const exited = new Promise<number | null>((resolve) => {
    proc.once("exit", (code) => resolve(code));
  });

  const result: PiSpawnLike = {
    stdin,
    stdout: streamToAsyncIterable(proc.stdout as NodeReadable),
    ...(proc.stderr ? { stderr: streamToAsyncIterable(proc.stderr as NodeReadable) } : {}),
    exited,
    ...(typeof proc.pid === "number" ? { pid: proc.pid } : {}),
    kill: (signal) => {
      try {
        proc.kill(signal);
      } catch {
        // Already dead or permission denied; reap will resolve shortly.
      }
    },
  };
  return result;
}
