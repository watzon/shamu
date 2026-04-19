/**
 * Unit tests for the stdio transport. No real subprocess — every test
 * injects `spawnImpl` with a fake that exposes the same shape.
 *
 * Covers:
 *  - `send()` awaits drain-promise returns from stdin.
 *  - Incoming frames emerge on the `messages` iterable.
 *  - Malformed lines surface via `onProtocolError`.
 *  - `close()` issues SIGTERM and escalates to SIGKILL when the subprocess
 *    doesn't exit within the configured window.
 */

import { describe, expect, it } from "vitest";
import { AcpProtocolError } from "../src/errors.ts";
import { createStdioTransport, type StdioSpawnLike } from "../src/transport-stdio.ts";

interface FakeProc extends StdioSpawnLike {
  readonly stdinWrites: string[];
  readonly signals: Array<number | NodeJS.Signals>;
  feedStdout(text: string): void;
  closeStdout(): void;
  /** Mark the process exited (resolves `exited`). */
  exit(code: number | null): void;
}

/**
 * Build a minimal fake subprocess. `drainOn.Nth` forces the Nth write to
 * return a pending promise that the test resolves manually, exercising the
 * drain-await path.
 */
function makeFakeProc(opts: { drainOnNthWrite?: number } = {}): FakeProc {
  const stdinWrites: string[] = [];
  const signals: Array<number | NodeJS.Signals> = [];
  let drainResolver: (() => void) | null = null;
  let exitedResolve: (v: number | null) => void = () => {};
  const exited = new Promise<number | null>((r) => {
    exitedResolve = r;
  });
  // Stdout plumbing
  const outQueue: Uint8Array[] = [];
  const outWaiters: Array<(v: IteratorResult<Uint8Array>) => void> = [];
  let outClosed = false;
  const encoder = new TextEncoder();

  const stdout: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        async next() {
          const buffered = outQueue.shift();
          if (buffered) return { value: buffered, done: false };
          if (outClosed) return { value: undefined, done: true };
          return new Promise<IteratorResult<Uint8Array>>((resolve) => outWaiters.push(resolve));
        },
      };
    },
  };

  const feedStdout = (text: string): void => {
    if (outClosed) return;
    const buf = encoder.encode(text);
    const w = outWaiters.shift();
    if (w) w({ value: buf, done: false });
    else outQueue.push(buf);
  };

  const closeStdout = (): void => {
    outClosed = true;
    while (outWaiters.length > 0) {
      const w = outWaiters.shift();
      if (w) w({ value: undefined, done: true });
    }
  };

  let writeCount = 0;
  const proc: FakeProc = {
    stdinWrites,
    signals,
    stdin: {
      write(chunk) {
        writeCount += 1;
        const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        stdinWrites.push(text);
        if (opts.drainOnNthWrite === writeCount) {
          return new Promise<number>((resolve) => {
            drainResolver = () => resolve(text.length);
          });
        }
        return text.length;
      },
      end: () => {
        // no-op
      },
    },
    stdout,
    exited,
    kill(signal) {
      signals.push(signal ?? "SIGTERM");
    },
    feedStdout,
    closeStdout,
    exit(code) {
      exitedResolve(code);
    },
  };

  // expose the drain resolver via a property so tests can flip it.
  Object.defineProperty(proc, "resolveDrain", {
    value: () => drainResolver?.(),
    enumerable: false,
  });

  return proc;
}

describe("createStdioTransport — outbound framing", () => {
  it("send() writes one newline-terminated JSON frame to stdin", async () => {
    const proc = makeFakeProc();
    const transport = createStdioTransport({
      binary: "/fake/agent",
      args: ["acp"],
      spawnImpl: () => proc,
      sigkillTimeoutMs: 20,
    });
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(proc.stdinWrites.length).toBe(1);
    const frame = proc.stdinWrites[0] ?? "";
    expect(frame.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(frame.trim()) as { method: string };
    expect(parsed.method).toBe("initialize");
    proc.exit(0);
    await transport.close();
  });

  it("send() awaits a drain-promise return before resolving", async () => {
    const proc = makeFakeProc({ drainOnNthWrite: 1 });
    const transport = createStdioTransport({
      binary: "/fake/agent",
      args: ["acp"],
      spawnImpl: () => proc,
      sigkillTimeoutMs: 20,
    });
    let sent = false;
    const p = transport.send({ jsonrpc: "2.0", id: 1, method: "x" }).then(() => {
      sent = true;
    });
    // Let microtasks run; the drain promise is still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toBe(false);
    (proc as FakeProc & { resolveDrain: () => void }).resolveDrain();
    await p;
    expect(sent).toBe(true);
    proc.exit(0);
    await transport.close();
  });
});

describe("createStdioTransport — inbound framing", () => {
  it("parses incoming JSON frames from stdout", async () => {
    const proc = makeFakeProc();
    const transport = createStdioTransport({
      binary: "/fake/agent",
      spawnImpl: () => proc,
      sigkillTimeoutMs: 20,
    });
    proc.feedStdout('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    proc.feedStdout('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s"}}\n');
    proc.closeStdout();

    const frames: unknown[] = [];
    for await (const frame of transport.messages) frames.push(frame);
    expect(frames).toHaveLength(2);
    expect((frames[0] as { result: { ok: boolean } }).result.ok).toBe(true);
    expect((frames[1] as { method: string }).method).toBe("session/update");
    proc.exit(0);
    await transport.close();
  });

  it("routes malformed lines through onProtocolError and keeps draining", async () => {
    const proc = makeFakeProc();
    const errors: AcpProtocolError[] = [];
    const transport = createStdioTransport({
      binary: "/fake/agent",
      spawnImpl: () => proc,
      sigkillTimeoutMs: 20,
      onProtocolError: (e) => errors.push(e),
    });
    proc.feedStdout("garbage line\n");
    proc.feedStdout('{"jsonrpc":"2.0","method":"ping"}\n');
    proc.closeStdout();
    const frames: unknown[] = [];
    for await (const f of transport.messages) frames.push(f);
    expect(frames).toHaveLength(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(AcpProtocolError);
    proc.exit(0);
    await transport.close();
  });
});

describe("createStdioTransport — close escalation", () => {
  it("SIGTERM first; SIGKILL after the timeout if the peer still runs", async () => {
    const proc = makeFakeProc();
    const transport = createStdioTransport({
      binary: "/fake/agent",
      spawnImpl: () => proc,
      sigkillTimeoutMs: 25,
    });
    // Start close; do NOT resolve `exited` so the timeout fires.
    const p = transport.close();
    // Give the SIGTERM path a tick.
    await new Promise((r) => setTimeout(r, 60));
    expect(proc.signals[0]).toBe("SIGTERM");
    expect(proc.signals[1]).toBe("SIGKILL");
    // Let the close finish by resolving exited.
    proc.exit(null);
    await p;
  });

  it("does not SIGKILL if the subprocess exits before the timeout", async () => {
    const proc = makeFakeProc();
    const transport = createStdioTransport({
      binary: "/fake/agent",
      spawnImpl: () => proc,
      sigkillTimeoutMs: 500,
    });
    const p = transport.close();
    proc.exit(0); // resolves `exited` immediately
    await p;
    expect(proc.signals).toEqual(["SIGTERM"]);
  });
});
