/**
 * Cursor driver — owns the ACP subprocess + client. Isolates the vendor
 * binary behind a narrow interface the handle consumes so tests can
 * substitute a scripted double that never spawns a real subprocess.
 *
 * Two drivers ship:
 *
 * 1. `createRealCursorDriver` — wires `@shamu/protocol-acp`'s
 *    `createStdioTransport` + `createAcpClient` against the real
 *    `cursor-agent` binary. The adapter owns the subprocess lifecycle; on
 *    `close()` the transport reaps the process (SIGTERM then SIGKILL
 *    fallback after a short timeout).
 *
 * 2. Tests pass a scripted double via `driverFactory`. See
 *    `test/driver.test.ts`, `test/handle.test.ts`, `test/contract.test.ts`.
 *
 * ### Vendor path resolution
 *
 * Cursor Desktop ships the `agent` binary at `~/.local/bin/agent`. The
 * Phase 0 spike confirmed no npm distribution for the official binary
 * (`cursor-agent@1.0.3` on npm is an unrelated task-sequencer by a
 * different author). Resolution order:
 *
 *   1. `opts.vendorCliPath`
 *   2. `process.env.CURSOR_AGENT_PATH`
 *   3. `~/.local/bin/agent` (tilde-expanded via `os.homedir()`)
 *
 * If none of the above points at an existing file, we throw
 * `SpawnError` with the "Cursor Desktop not installed — see shamu doctor"
 * guidance.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
 * The narrow surface the Cursor handle consumes. Structurally identical to
 * `AcpClient` plus lifecycle plumbing.
 */
export interface CursorDriver {
  readonly client: AcpClient;
  /**
   * Close the subprocess (if owned) + release the client. MUST be
   * idempotent — `AgentHandle.shutdown()` may be called twice in error
   * paths.
   */
  close(): Promise<void>;
}

export interface CursorDriverOptions {
  /** Path to the `cursor-agent` binary. Override via `SpawnOpts.vendorCliPath`. */
  readonly vendorCliPath?: string;
  /** Working directory the subprocess runs in. Defaults to the run's cwd. */
  readonly cwd?: string;
  /**
   * Allow-listed env. If not provided, a minimal PATH/HOME passthrough is
   * applied (ACP binaries shell out to Node / keychain).
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Extra args appended after `acp`. Tests use this to pin debug flags.
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
export function resolveCursorBinaryPath(options: {
  readonly vendorCliPath?: string;
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Inject an alternative existence check. Defaults to `fs.existsSync`.
   * Tests pass a stub so they don't need a real binary on disk.
   */
  readonly existsImpl?: (path: string) => boolean;
  /** Inject `os.homedir()` for test determinism. */
  readonly homedirImpl?: () => string;
}): string {
  const exists = options.existsImpl ?? existsSync;
  const home = options.homedirImpl ?? homedir;

  const explicit = options.vendorCliPath;
  if (explicit && explicit.length > 0) {
    if (exists(explicit)) return explicit;
    throw new SpawnError(
      `Cursor ACP binary not found at vendorCliPath=${explicit} (file does not exist)`,
    );
  }
  const envPath = options.env?.CURSOR_AGENT_PATH ?? process.env.CURSOR_AGENT_PATH;
  if (envPath && envPath.length > 0) {
    if (exists(envPath)) return envPath;
    throw new SpawnError(
      `Cursor ACP binary not found at CURSOR_AGENT_PATH=${envPath} (file does not exist)`,
    );
  }
  const defaultPath = join(home(), ".local", "bin", "agent");
  if (exists(defaultPath)) return defaultPath;
  throw new SpawnError(
    `Cursor ACP binary not found. Looked at ${defaultPath}. Cursor Desktop is not installed — see \`shamu doctor\`. Override with vendorCliPath or CURSOR_AGENT_PATH.`,
  );
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
 *  2. Spawn `<binary> acp [extraArgs]` via `createStdioTransport`.
 *  3. Wrap the transport in an `AcpClient`.
 *  4. Return a `CursorDriver` whose `close()` reaps the process.
 *
 * Construction-time failures do not leak a half-open transport — the
 * outer adapter's rollback path calls `close()` explicitly.
 */
export async function createRealCursorDriver(options: CursorDriverOptions): Promise<CursorDriver> {
  const binary = resolveCursorBinaryPath({
    ...(options.vendorCliPath !== undefined ? { vendorCliPath: options.vendorCliPath } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  const args: string[] = ["acp", ...(options.extraArgs ?? [])];
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
      `Failed to spawn cursor-agent: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }

  let client: AcpClient;
  try {
    client = createAcpClient(transport, options.clientOptions ?? {});
  } catch (cause) {
    // Unlikely, but if createAcpClient itself throws, reap the transport.
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
