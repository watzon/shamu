/**
 * Unit tests for the Pi driver layer. These DO NOT spawn a real `pi`
 * subprocess — we exercise the vendor-path resolver and the driver
 * lifecycle via an injected `spawnImpl` double.
 *
 * Live coverage (real `pi --mode rpc`) lives in `test/live/*.live.test.ts`
 * gated behind `SHAMU_PI_LIVE=1`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRealPiDriver, type PiSpawnLike, resolvePiBinaryPath } from "../src/driver.ts";

describe("resolvePiBinaryPath", () => {
  it("prefers an explicit vendorCliPath when it exists", () => {
    const path = resolvePiBinaryPath({
      vendorCliPath: "/custom/pi",
      existsImpl: (p) => p === "/custom/pi",
      whichImpl: () => null,
    });
    expect(path).toBe("/custom/pi");
  });

  it("throws when the explicit vendorCliPath is missing", () => {
    expect(() =>
      resolvePiBinaryPath({
        vendorCliPath: "/missing/pi",
        existsImpl: () => false,
        whichImpl: () => null,
      }),
    ).toThrow(/not found/);
  });

  it("falls through to PI_CLI_PATH env when vendorCliPath is unset", () => {
    const path = resolvePiBinaryPath({
      env: { PI_CLI_PATH: "/env/pi" },
      existsImpl: (p) => p === "/env/pi",
      whichImpl: () => null,
    });
    expect(path).toBe("/env/pi");
  });

  it("falls through to which('pi') when env is unset", () => {
    const path = resolvePiBinaryPath({
      env: {},
      existsImpl: (p) => p === "/usr/local/bin/pi",
      whichImpl: () => "/usr/local/bin/pi",
    });
    expect(path).toBe("/usr/local/bin/pi");
  });

  it("throws a helpful error when all fallbacks miss", () => {
    expect(() =>
      resolvePiBinaryPath({
        env: {},
        existsImpl: () => false,
        whichImpl: () => null,
      }),
    ).toThrow(/install with `npm install -g @mariozechner\/pi-coding-agent`/);
  });
});

/** Build a spawn double whose stdout optionally pushes a `ready` frame. */
function makeSpawn(opts: { emitReady?: boolean; exitImmediately?: boolean } = {}): {
  spawn: () => PiSpawnLike;
  terminated: () => boolean;
  stdout: { push(msg: string): void; end(): void };
  stdin: { writes: string[] };
  pid: number;
} {
  const stdinWrites: string[] = [];
  const stdoutChunks: Uint8Array[] = [];
  let stdoutEnded = false;
  let stdoutResolver: ((v: IteratorResult<Uint8Array>) => void) | null = null;
  const stdout = {
    push(msg: string) {
      const enc = new TextEncoder().encode(msg);
      if (stdoutResolver) {
        const r = stdoutResolver;
        stdoutResolver = null;
        r({ value: enc, done: false });
      } else {
        stdoutChunks.push(enc);
      }
    },
    end() {
      stdoutEnded = true;
      if (stdoutResolver) {
        const r = stdoutResolver;
        stdoutResolver = null;
        r({ value: undefined as unknown as Uint8Array, done: true });
      }
    },
  };
  async function* stdoutIter(): AsyncGenerator<Uint8Array, void, unknown> {
    while (true) {
      const buffered = stdoutChunks.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      if (stdoutEnded) return;
      const next = await new Promise<IteratorResult<Uint8Array>>((resolve) => {
        stdoutResolver = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }

  let terminated = false;
  let exitResolve: (v: number | null) => void = () => {};
  const exited = new Promise<number | null>((r) => {
    exitResolve = r;
  });

  if (opts.exitImmediately) {
    // Signal exit inside the event loop tick so the driver's
    // subprocess-exit listener wires up BEFORE we resolve. End stdout
    // too so the client's consume loop can unwind cleanly after the
    // rollback path runs.
    setTimeout(() => {
      exitResolve(1);
      stdout.end();
    }, 1);
  }

  const spawn = (): PiSpawnLike => {
    if (opts.emitReady) {
      // Schedule a ready frame right after construction.
      setTimeout(() => stdout.push('{"type":"ready","version":"0.67.68"}\n'), 0);
    }
    return {
      stdin: {
        write(chunk: string | Uint8Array): number {
          stdinWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
          return chunk.length;
        },
        async end() {
          // no-op
        },
      },
      stdout: stdoutIter(),
      exited,
      pid: 12345,
      kill: () => {
        terminated = true;
        exitResolve(null);
        stdout.end();
      },
    };
  };

  return {
    spawn,
    terminated: () => terminated,
    stdout,
    stdin: { writes: stdinWrites },
    pid: 12345,
  };
}

describe("createRealPiDriver — handshake + lifecycle", () => {
  let realEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    realEnv = { ...process.env };
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in realEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(realEnv)) {
      process.env[k] = v;
    }
  });

  it("spawns + resolves when a ready frame arrives early", async () => {
    const s = makeSpawn({ emitReady: true });
    const driver = await createRealPiDriver({
      vendorCliPath: process.execPath, // must exist
      spawnImpl: s.spawn,
      handshakeGraceMs: 10_000,
      handshakeTimeoutMs: 20_000,
      sigkillTimeoutMs: 100,
    });
    await driver.close();
    await driver.close(); // idempotent
  });

  it("resolves after the grace window even without a ready frame (Pi's real protocol has none)", async () => {
    const s = makeSpawn();
    const driver = await createRealPiDriver({
      vendorCliPath: process.execPath,
      spawnImpl: s.spawn,
      handshakeGraceMs: 20,
      handshakeTimeoutMs: 500,
      sigkillTimeoutMs: 100,
    });
    await driver.close();
  });

  it("rejects when the subprocess exits during handshake", async () => {
    const s = makeSpawn({ exitImmediately: true });
    await expect(
      createRealPiDriver({
        vendorCliPath: process.execPath,
        spawnImpl: s.spawn,
        handshakeGraceMs: 5000,
        handshakeTimeoutMs: 10_000,
        sigkillTimeoutMs: 100,
      }),
    ).rejects.toThrow(/exited during handshake/);
  });

  it("surfaces missing binary as SpawnError", async () => {
    await expect(
      createRealPiDriver({
        vendorCliPath: "/definitely/not/here",
      }),
    ).rejects.toThrow(/vendorCliPath/);
  });

  it("close reaps the subprocess (calls kill)", async () => {
    const s = makeSpawn({ emitReady: true });
    const driver = await createRealPiDriver({
      vendorCliPath: process.execPath,
      spawnImpl: s.spawn,
      handshakeGraceMs: 5000,
      handshakeTimeoutMs: 10_000,
      sigkillTimeoutMs: 50,
    });
    await driver.close();
    expect(s.terminated()).toBe(true);
  });
});
