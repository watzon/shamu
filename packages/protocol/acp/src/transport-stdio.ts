/**
 * `createStdioTransport` — spawn a subprocess and speak ACP JSON-RPC 2.0 over
 * its stdin (outgoing) and stdout (incoming).
 *
 * ### Recurring constraints (PLAN § "Known recurring constraints")
 *
 * - **Node-style drain** on stdin. Cursor's `agent acp` and Gemini's
 *   `gemini --acp` are both Node processes; Bun fire-and-forget writes
 *   under load break them. Each `send()` awaits the underlying `FileSink`
 *   write promise when the buffer is full.
 * - **LF-only JSONL** on stdout. Framing lives in `framing.ts`.
 * - **Per-line malformed tolerance.** Framing yields either `{frame}` or
 *   `{error}`; this transport keeps pushing frames into `messages`. The
 *   client sees valid frames; protocol errors surface via the client's
 *   `onProtocolError` handler (the transport bridges them by throwing into
 *   the messages iterator? no — we surface via a side channel so the
 *   consumer never has to filter. See `errorHandler` option below.)
 *
 * ### Close semantics
 *
 * `close()`:
 *  1. sends `SIGTERM` to the subprocess group;
 *  2. waits up to `sigkillTimeoutMs` for it to exit;
 *  3. sends `SIGKILL` if still alive;
 *  4. resolves once the subprocess has exited or we've sent the fallback kill.
 *
 * `messages` completes once the subprocess closes its stdout.
 *
 * ### Test seam
 *
 * The transport accepts an optional `spawnImpl` factory so unit tests can
 * substitute a fake-subprocess that exposes `stdin` / `stdout` / `kill` /
 * `exited`. Production wires `Bun.spawn` via `createStdioTransport`.
 */

import type { AcpJsonRpcTransport } from "./client.ts";
import { AcpError, type AcpProtocolError } from "./errors.ts";
import { bytesToStrings, decodeFrames, encodeFrame } from "./framing.ts";

export interface StdioSpawnLike {
  /** FileSink. `write` may return a number (sync accepted) OR a Promise<number> (must await for drain). */
  readonly stdin: {
    write(chunk: string | Uint8Array): number | Promise<number>;
    end?(): void | Promise<void>;
    flush?(): number | Promise<number>;
  };
  /** WHATWG ReadableStream<Uint8Array>. */
  readonly stdout: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
  readonly stderr?: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;
  readonly exited: Promise<number | null>;
  readonly pid?: number;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface CreateStdioTransportOptions {
  readonly binary: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Inject a fake spawn implementation for tests. */
  readonly spawnImpl?: (opts: {
    readonly binary: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string | undefined;
  }) => StdioSpawnLike;
  /** SIGKILL fallback delay after SIGTERM. Default 2000 ms. */
  readonly sigkillTimeoutMs?: number;
  /**
   * Called for every malformed inbound line. If omitted, protocol errors
   * are silently dropped (the client's `onProtocolError` handler is the
   * normal reporting surface; tests can attach here directly).
   */
  readonly onProtocolError?: (err: AcpProtocolError) => void;
  /** Called for every stderr chunk (decoded as UTF-8). Default: drop. */
  readonly onStderr?: (chunk: string) => void;
}

/**
 * Spawn + own a subprocess speaking ACP over stdio. Returns a ready-to-use
 * `AcpJsonRpcTransport` suitable for `createAcpClient(transport)`.
 */
export function createStdioTransport(opts: CreateStdioTransportOptions): AcpJsonRpcTransport {
  const sp = opts.spawnImpl ?? defaultSpawnImpl;
  const proc = sp({
    binary: opts.binary,
    args: opts.args ?? [],
    env: opts.env ?? {},
    cwd: opts.cwd,
  });

  const sigkillTimeoutMs = opts.sigkillTimeoutMs ?? 2_000;

  const messages = buildMessages(proc, opts.onProtocolError);
  if (opts.onStderr && proc.stderr) {
    void pumpStderr(proc.stderr, opts.onStderr).catch(() => {
      // swallow — stderr pump is best-effort.
    });
  }

  let closed = false;

  const send = async (frame: object): Promise<void> => {
    if (closed) {
      throw new AcpError("stdio transport is closed");
    }
    const encoded = encodeFrame(frame);
    // UTF-8 encode once; stdin.write accepts both strings and byte buffers,
    // but a byte buffer lets us observe backpressure via the Promise return
    // predictably across Bun releases.
    const buf = new TextEncoder().encode(encoded);
    try {
      const r = proc.stdin.write(buf);
      if (typeof r === "number") return;
      await r;
    } catch (cause) {
      throw new AcpError(
        `stdio transport write failed: ${(cause as Error)?.message ?? String(cause)}`,
        cause,
      );
    }
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // End stdin so the peer knows we're done writing.
    try {
      await proc.stdin.end?.();
    } catch {
      // ignore
    }
    // SIGTERM; escalate to SIGKILL if the peer doesn't exit within the timeout.
    try {
      proc.kill("SIGTERM");
    } catch {
      // already dead
    }
    const raceResult = await Promise.race<"exited" | "timeout">([
      proc.exited.then(() => "exited" as const).catch(() => "exited" as const),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), sigkillTimeoutMs);
      }),
    ]);
    if (raceResult === "timeout") {
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
  };

  return { send, messages, close };
}

async function* buildMessages(
  proc: StdioSpawnLike,
  onProtocolError: ((err: AcpProtocolError) => void) | undefined,
): AsyncIterable<unknown> {
  const byteStream = toAsyncIterable(proc.stdout);
  const stringStream = bytesToStrings(byteStream);
  for await (const line of decodeFrames(stringStream)) {
    if (line.kind === "frame") {
      yield line.frame;
      continue;
    }
    // kind === "error"
    if (onProtocolError) {
      try {
        onProtocolError(line.error);
      } catch {
        // swallow
      }
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
    const decoded = decoder.decode(chunk, { stream: true });
    if (decoded.length > 0) onStderr(decoded);
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
 * Default production spawn: `Bun.spawn`. We don't pull in `@shamu/adapters-base`'s
 * `spawnVendorSubprocess` helper here because the protocol package must stay
 * free of adapter-layer deps (it'll be consumed by A2A in Phase 8). Adapters
 * that want the harder drain/env semantics can inject `spawnImpl` that wraps
 * the base helper.
 */
function defaultSpawnImpl(opts: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | undefined;
}): StdioSpawnLike {
  if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
    throw new AcpError("createStdioTransport requires Bun; tests should inject spawnImpl");
  }
  try {
    const proc = Bun.spawn({
      cmd: [opts.binary, ...opts.args],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: { ...opts.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    } as unknown as Parameters<typeof Bun.spawn>[0]) as unknown as {
      stdin: StdioSpawnLike["stdin"];
      stdout: ReadableStream<Uint8Array>;
      stderr: ReadableStream<Uint8Array>;
      exited: Promise<number | null>;
      pid?: number;
      kill(signal?: number | NodeJS.Signals): void;
    };
    const result: StdioSpawnLike = {
      stdin: proc.stdin,
      stdout: proc.stdout,
      ...(proc.stderr ? { stderr: proc.stderr } : {}),
      exited: proc.exited,
      ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
      kill: (signal) => proc.kill(signal),
    };
    return result;
  } catch (cause) {
    throw new AcpError(
      `Failed to spawn ACP binary ${opts.binary}: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }
}
