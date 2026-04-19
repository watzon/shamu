/**
 * Gemini driver — owns the ACP subprocess + client. Isolates the vendor
 * binary behind a narrow interface the handle consumes so tests can
 * substitute a scripted double that never spawns a real subprocess.
 *
 * Two drivers ship:
 *
 * 1. `createRealGeminiDriver` — wires `@shamu/protocol-acp`'s
 *    `createStdioTransport` + `createAcpClient` against the real `gemini`
 *    binary from `@google/gemini-cli`. The adapter owns the subprocess
 *    lifecycle; on `close()` the transport reaps the process (SIGTERM then
 *    SIGKILL fallback after a short timeout).
 *
 * 2. Tests pass a scripted double via `driverFactory`. See
 *    `test/driver.test.ts`, `test/handle.test.ts`, `test/contract.test.ts`.
 *
 * ### Vendor path resolution
 *
 * `@google/gemini-cli` ships as an `npm install -g` dependency and places
 * the `gemini` binary on `$PATH`. We do NOT take a runtime dependency on
 * `@google/gemini-cli` (~111 MB unpacked); users install it themselves.
 * Resolution order:
 *
 *   1. `opts.vendorCliPath`
 *   2. `process.env.GEMINI_CLI_PATH`
 *   3. `Bun.which("gemini")` (falls back to scanning `$PATH` segments if
 *      Bun.which is unavailable — e.g., Node-under-Vitest context)
 *   4. Error with a "Gemini CLI not found" message that points at the
 *      install instructions.
 *
 * If none of the above points at an existing file, we throw `SpawnError`.
 *
 * ### Stdout corruption (gemini-cli#22647)
 *
 * The upstream issue notes non-ACP writes can bleed into the JSON-RPC
 * stream. The protocol-acp client already validates every line via
 * `decodeFrames` and emits malformed frames as `AcpProtocolError` to the
 * `onProtocolError` fanout. The handle maps those to non-fatal `error`
 * AgentEvents with `errorCode: "acp_protocol"`. No adapter-level line
 * scrubbing is required — the client's per-line validation is the fix.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { SpawnError } from "@shamu/adapters-base";
import {
  type AcpClient,
  type AcpClientOptions,
  type AcpJsonRpcTransport,
  type AcpProtocolError,
  type CreateStdioTransportOptions,
  createAcpClient,
  createStdioTransport,
} from "@shamu/protocol-acp";

/**
 * The narrow surface the Gemini handle consumes. Structurally identical to
 * `AcpClient` plus lifecycle plumbing.
 */
export interface GeminiDriver {
  readonly client: AcpClient;
  /**
   * Close the subprocess (if owned) + release the client. MUST be
   * idempotent — `AgentHandle.shutdown()` may be called twice in error
   * paths.
   */
  close(): Promise<void>;
}

export interface GeminiDriverOptions {
  /** Path to the `gemini` binary. Override via `SpawnOpts.vendorCliPath`. */
  readonly vendorCliPath?: string;
  /** Working directory the subprocess runs in. Defaults to the run's cwd. */
  readonly cwd?: string;
  /**
   * Allow-listed env. If not provided, a minimal PATH/HOME passthrough is
   * applied (Gemini CLI shells out to Node / keychain).
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Extra args appended after `--acp`. Tests use this to pin debug flags.
   */
  readonly extraArgs?: readonly string[];
  /** SIGKILL fallback delay; default 2000 ms. */
  readonly sigkillTimeoutMs?: number;
  /** ACP client options (request timeout, etc.). */
  readonly clientOptions?: AcpClientOptions;
  /** Protocol-error sink (e.g., route to the handle's error emitter). */
  readonly onProtocolError?: (err: AcpProtocolError) => void;
  /** Stderr chunk sink (e.g., route to logger). */
  readonly onStderr?: (chunk: string) => void;
  /** Test seam — inject a raw transport factory to bypass subprocess spawn. */
  readonly transportFactory?: (opts: CreateStdioTransportOptions) => AcpJsonRpcTransport;
}

/**
 * Resolve the vendor binary path. Exported for tests + for `shamu doctor`
 * to reuse the same search order.
 */
export function resolveGeminiBinaryPath(options: {
  readonly vendorCliPath?: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Inject an alternative existence check. Defaults to `fs.existsSync`.
   * Tests pass a stub so they don't need a real binary on disk.
   */
  readonly existsImpl?: (path: string) => boolean;
  /**
   * Inject a `which`-like resolver. Defaults to a best-effort lookup that
   * prefers `Bun.which` when available, then falls back to walking
   * `$PATH`.
   */
  readonly whichImpl?: (bin: string) => string | null;
}): string {
  const exists = options.existsImpl ?? existsSync;
  const which = options.whichImpl ?? defaultWhich;

  const explicit = options.vendorCliPath;
  if (explicit && explicit.length > 0) {
    if (exists(explicit)) return explicit;
    throw new SpawnError(
      `Gemini CLI binary not found at vendorCliPath=${explicit} (file does not exist)`,
    );
  }
  const envPath = options.env?.GEMINI_CLI_PATH ?? process.env.GEMINI_CLI_PATH;
  if (envPath && envPath.length > 0) {
    if (exists(envPath)) return envPath;
    throw new SpawnError(
      `Gemini CLI binary not found at GEMINI_CLI_PATH=${envPath} (file does not exist)`,
    );
  }
  const onPath = which("gemini");
  if (onPath && onPath.length > 0 && exists(onPath)) {
    return onPath;
  }
  throw new SpawnError(
    "Gemini CLI not found — install `@google/gemini-cli` (npm install -g @google/gemini-cli) or set GEMINI_CLI_PATH / vendorCliPath.",
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
 * known to need. Extended by `options.env`.
 */
function defaultEnv(extra: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "USER", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
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
 *  2. Spawn `<binary> --acp [extraArgs]` via `createStdioTransport`.
 *  3. Wrap the transport in an `AcpClient`.
 *  4. Return a `GeminiDriver` whose `close()` reaps the process.
 *
 * Construction-time failures do not leak a half-open transport — the
 * outer adapter's rollback path calls `close()` explicitly.
 */
export async function createRealGeminiDriver(options: GeminiDriverOptions): Promise<GeminiDriver> {
  const binary = resolveGeminiBinaryPath({
    ...(options.vendorCliPath !== undefined ? { vendorCliPath: options.vendorCliPath } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  const args: string[] = ["--acp", ...(options.extraArgs ?? [])];
  const transportOpts: CreateStdioTransportOptions = {
    binary,
    args,
    env: defaultEnv(options.env),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.sigkillTimeoutMs !== undefined
      ? { sigkillTimeoutMs: options.sigkillTimeoutMs }
      : {}),
    ...(options.onProtocolError !== undefined ? { onProtocolError: options.onProtocolError } : {}),
    ...(options.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
  };
  let transport: AcpJsonRpcTransport;
  try {
    const factory = options.transportFactory ?? createStdioTransport;
    transport = factory(transportOpts);
  } catch (cause) {
    throw new SpawnError(
      `Failed to spawn gemini --acp: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }

  let client: AcpClient;
  try {
    client = createAcpClient(transport, options.clientOptions ?? {});
  } catch (cause) {
    try {
      await transport.close();
    } catch {
      // ignore
    }
    throw new SpawnError(
      `Failed to initialize ACP client: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }

  let closed = false;
  return {
    client,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await client.close();
      } catch {
        // client.close is best-effort; swallow.
      }
    },
  };
}
