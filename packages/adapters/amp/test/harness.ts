/**
 * Shared test harness: a scripted `AmpDriver` that records calls and lets
 * each test push synthetic JSONL stdout lines + stderr chunks on demand.
 *
 * Mirrors the shape of the Cursor / OpenCode harnesses: a single-producer
 * async queue backs `readLines()` / `readStderr()`; `writeLine()` appends
 * to `stdinWrites`; `closeStdin()` marks stdin closed; `kill()` marks the
 * subprocess killed. `close()` is idempotent.
 */

import type { AmpDriver } from "../src/driver.ts";

export interface FakeDriverHarness {
  readonly driver: AmpDriver;
  /** Push a synthetic JSONL line to the stdout stream. */
  pushLine(line: string): void;
  /** Push synthetic stderr text. */
  pushStderr(chunk: string): void;
  /** Close the stdout stream (simulates subprocess EOF). */
  closeStdout(): void;
  /** Close the stderr stream. */
  closeStderr(): void;
  /** All writes sent to stdin in order. */
  readonly stdinWrites: readonly string[];
  /** Has stdin been closed? */
  stdinClosed(): boolean;
  /** Has the subprocess been killed? */
  killed(): boolean;
  /** Has the driver been closed? */
  closed(): boolean;
}

export function makeFakeDriver(): FakeDriverHarness {
  const stdinWrites: string[] = [];
  let isStdinClosed = false;
  let isKilled = false;
  let isClosed = false;

  const stdoutQueue: string[] = [];
  const stdoutWaiters: Array<(v: IteratorResult<string>) => void> = [];
  let stdoutDone = false;

  const stderrQueue: string[] = [];
  const stderrWaiters: Array<(v: IteratorResult<string>) => void> = [];
  let stderrDone = false;

  const pushLine = (line: string): void => {
    if (stdoutDone) return;
    const w = stdoutWaiters.shift();
    if (w) {
      w({ value: line, done: false });
      return;
    }
    stdoutQueue.push(line);
  };

  const pushStderr = (chunk: string): void => {
    if (stderrDone) return;
    const w = stderrWaiters.shift();
    if (w) {
      w({ value: chunk, done: false });
      return;
    }
    stderrQueue.push(chunk);
  };

  const closeStdout = (): void => {
    stdoutDone = true;
    while (stdoutWaiters.length > 0) {
      const w = stdoutWaiters.shift();
      if (w) w({ value: undefined, done: true });
    }
  };

  const closeStderr = (): void => {
    stderrDone = true;
    while (stderrWaiters.length > 0) {
      const w = stderrWaiters.shift();
      if (w) w({ value: undefined, done: true });
    }
  };

  const driver: AmpDriver = {
    async *readLines(): AsyncIterableIterator<string> {
      while (!stdoutDone) {
        const buf = stdoutQueue.shift();
        if (buf !== undefined) {
          yield buf;
          continue;
        }
        const next = await new Promise<IteratorResult<string>>((resolve) => {
          stdoutWaiters.push(resolve);
        });
        if (next.done) return;
        yield next.value;
      }
      // Drain anything still buffered after close.
      while (stdoutQueue.length > 0) {
        const buf = stdoutQueue.shift();
        if (buf !== undefined) yield buf;
      }
    },
    async *readStderr(): AsyncIterableIterator<string> {
      while (!stderrDone) {
        const buf = stderrQueue.shift();
        if (buf !== undefined) {
          yield buf;
          continue;
        }
        const next = await new Promise<IteratorResult<string>>((resolve) => {
          stderrWaiters.push(resolve);
        });
        if (next.done) return;
        yield next.value;
      }
      while (stderrQueue.length > 0) {
        const buf = stderrQueue.shift();
        if (buf !== undefined) yield buf;
      }
    },
    async writeLine(line: string) {
      if (isStdinClosed) {
        throw new Error("FakeDriver: writeLine after stdin closed");
      }
      stdinWrites.push(line);
    },
    async closeStdin() {
      isStdinClosed = true;
    },
    kill() {
      isKilled = true;
      // A kill terminates stdout/stderr too.
      closeStdout();
      closeStderr();
    },
    async close() {
      if (isClosed) return;
      isClosed = true;
      isStdinClosed = true;
      closeStdout();
      closeStderr();
    },
  };

  return {
    driver,
    pushLine,
    pushStderr,
    closeStdout,
    closeStderr,
    get stdinWrites() {
      return stdinWrites;
    },
    stdinClosed: () => isStdinClosed,
    killed: () => isKilled,
    closed: () => isClosed,
  };
}
