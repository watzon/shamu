/**
 * Unit tests for `ensureClaudeSidecar` and the pins table.
 *
 * All tests inject a fake fetch + in-memory filesystem via the test seams
 * on `EnsureClaudeSidecarOptions`. No network, no real fs.
 *
 * Coverage:
 *   - Pin table shape (string keys → string values)
 *   - Explicit `opts.path` short-circuit
 *   - `$SHAMU_CLAUDE_SIDECAR_PATH` env short-circuit
 *   - Cached binary passes SHA → no download
 *   - Fresh download + SHA match → atomic install
 *   - Fresh download + SHA mismatch → throws with clear diagnostic
 *   - Retry exhaustion after 3 attempts → throws
 *   - Non-2xx counts as a retry
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ensureClaudeSidecar,
  type SidecarFetchFn as FetchFn,
  SIDECAR_PINS,
  SIDECAR_VERSION,
  type SidecarFs,
} from "../src/index.ts";

function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  // Copy into a fresh ArrayBuffer so the returned value is never a view
  // over a shared buffer (which would tempt fetch-mock consumers to mutate
  // the test payload).
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

/** Minimal in-memory filesystem honoring the `SidecarFs` surface. */
function makeFakeFs(seed: Record<string, Uint8Array> = {}): {
  readonly fs: SidecarFs;
  readonly files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>(Object.entries(seed));
  const dirs = new Set<string>();
  const fs: SidecarFs = {
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      const v = files.get(p);
      if (!v) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFileSync: (p, data) => {
      files.set(p, data);
    },
    mkdirSync: (p) => {
      dirs.add(p);
    },
    renameSync: (from, to) => {
      const v = files.get(from);
      if (!v) throw new Error(`ENOENT: ${from}`);
      files.delete(from);
      files.set(to, v);
    },
    chmodSync: () => {
      // no-op in-memory; the real fs handles the exec bit
    },
    unlinkSync: (p) => {
      files.delete(p);
    },
    statSync: (p) => {
      const v = files.get(p);
      if (!v) throw new Error(`ENOENT: ${p}`);
      return { isFile: () => true, size: v.length };
    },
  };
  return { fs, files };
}

function makeStaticFetch(payload: Uint8Array): {
  readonly fetchFn: FetchFn;
  readonly counter: { calls: number };
} {
  const counter = { calls: 0 };
  const fetchFn: FetchFn = async () => {
    counter.calls += 1;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => toArrayBuffer(payload),
    };
  };
  return { fetchFn, counter };
}

function makeAlwaysFailingFetch(): {
  readonly fetchFn: FetchFn;
  readonly counter: { calls: number };
} {
  const counter = { calls: 0 };
  const fetchFn: FetchFn = async () => {
    counter.calls += 1;
    throw new Error(`simulated network error ${counter.calls}`);
  };
  return { fetchFn, counter };
}

// Avoid real setTimeout waits in the retry loop.
const noSleep = async (_ms: number): Promise<void> => {};

describe("SIDECAR_PINS shape", () => {
  it("maps every supported platform key to a non-empty string", () => {
    for (const key of Object.keys(SIDECAR_PINS)) {
      const val = SIDECAR_PINS[key];
      expect(typeof val).toBe("string");
      expect((val as string).length).toBeGreaterThan(0);
    }
  });

  it("covers at least darwin-arm64 and linux-x64", () => {
    expect(Object.keys(SIDECAR_PINS)).toEqual(
      expect.arrayContaining(["darwin-arm64", "linux-x64"]),
    );
  });

  it("exposes a non-empty SIDECAR_VERSION string", () => {
    expect(typeof SIDECAR_VERSION).toBe("string");
    expect(SIDECAR_VERSION.length).toBeGreaterThan(0);
  });
});

describe("ensureClaudeSidecar — explicit path", () => {
  it("honors an explicit path when present", async () => {
    const { fs } = makeFakeFs({ "/some/where/claude": new Uint8Array([1, 2, 3]) });
    const { fetchFn, counter } = makeStaticFetch(new Uint8Array());
    const res = await ensureClaudeSidecar({
      path: "/some/where/claude",
      fsImpl: fs,
      fetchFn,
      env: {},
      platform: "darwin-arm64",
    });
    expect(res.path).toBe("/some/where/claude");
    expect(res.version).toBe(SIDECAR_VERSION);
    // Explicit path must not trigger a download.
    expect(counter.calls).toBe(0);
  });

  it("throws a clear error when the explicit path is missing", async () => {
    const { fs } = makeFakeFs();
    await expect(
      ensureClaudeSidecar({
        path: "/missing/claude",
        fsImpl: fs,
        env: {},
        platform: "darwin-arm64",
      }),
    ).rejects.toThrow(/explicit path '\/missing\/claude' does not exist/);
  });
});

describe("ensureClaudeSidecar — env var", () => {
  it("honors SHAMU_CLAUDE_SIDECAR_PATH when present", async () => {
    const { fs } = makeFakeFs({ "/env/claude": new Uint8Array([9]) });
    const { fetchFn, counter } = makeStaticFetch(new Uint8Array());
    const res = await ensureClaudeSidecar({
      fsImpl: fs,
      fetchFn,
      env: { SHAMU_CLAUDE_SIDECAR_PATH: "/env/claude" },
      platform: "darwin-arm64",
    });
    expect(res.path).toBe("/env/claude");
    expect(counter.calls).toBe(0);
  });

  it("throws when the env var points to a missing file", async () => {
    const { fs } = makeFakeFs();
    await expect(
      ensureClaudeSidecar({
        fsImpl: fs,
        env: { SHAMU_CLAUDE_SIDECAR_PATH: "/nope" },
        platform: "darwin-arm64",
      }),
    ).rejects.toThrow(/SHAMU_CLAUDE_SIDECAR_PATH points to '\/nope'/);
  });
});

describe("ensureClaudeSidecar — cache hit", () => {
  it("returns cached path and skips fetch when SHA matches the pin", async () => {
    const payload = new Uint8Array([42, 42, 42, 42, 42]);
    const sha = sha256Hex(payload);
    const cacheRoot = "/cache";
    const finalPath = `${cacheRoot}/${SIDECAR_VERSION}/claude`;
    const { fs } = makeFakeFs({ [finalPath]: payload });
    const { fetchFn, counter } = makeStaticFetch(new Uint8Array([0, 0, 0]));
    const res = await ensureClaudeSidecar({
      fsImpl: fs,
      fetchFn,
      env: {},
      platform: "darwin-arm64",
      cacheRoot,
      sleep: noSleep,
      expectedSha: sha,
    });
    expect(res.path).toBe(finalPath);
    expect(counter.calls).toBe(0);
  });

  it("re-downloads and overwrites when the cached file's SHA does not match", async () => {
    const correctPayload = new Uint8Array([5, 5, 5]);
    const sha = sha256Hex(correctPayload);
    const staleCached = new Uint8Array([9, 9, 9]);
    const cacheRoot = "/cache";
    const finalPath = `${cacheRoot}/${SIDECAR_VERSION}/claude`;
    const { fs, files } = makeFakeFs({ [finalPath]: staleCached });
    const { fetchFn, counter } = makeStaticFetch(correctPayload);
    const res = await ensureClaudeSidecar({
      fsImpl: fs,
      fetchFn,
      env: {},
      platform: "darwin-arm64",
      cacheRoot,
      sleep: noSleep,
      expectedSha: sha,
    });
    expect(res.path).toBe(finalPath);
    expect(counter.calls).toBe(1);
    expect(Array.from(files.get(finalPath) ?? [])).toEqual(Array.from(correctPayload));
  });
});

describe("ensureClaudeSidecar — fresh download", () => {
  it("atomically installs a verified binary", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const sha = sha256Hex(payload);
    const cacheRoot = "/cache";
    const finalPath = `${cacheRoot}/${SIDECAR_VERSION}/claude`;
    const { fs, files } = makeFakeFs();
    const { fetchFn, counter } = makeStaticFetch(payload);
    const res = await ensureClaudeSidecar({
      fsImpl: fs,
      fetchFn,
      env: {},
      platform: "linux-x64",
      cacheRoot,
      sleep: noSleep,
      expectedSha: sha,
    });
    expect(res.path).toBe(finalPath);
    expect(res.version).toBe(SIDECAR_VERSION);
    expect(counter.calls).toBe(1);
    expect(Array.from(files.get(finalPath) ?? [])).toEqual(Array.from(payload));
    // No partial file should be left behind.
    for (const name of files.keys()) {
      expect(name).not.toMatch(/\.partial-/);
    }
  });

  it("throws a SHA-mismatch error that names both the expected and actual digests", async () => {
    const payload = new Uint8Array([7, 7, 7]);
    const actualSha = sha256Hex(payload);
    const wrongSha = "0".repeat(64);
    const { fs } = makeFakeFs();
    const { fetchFn } = makeStaticFetch(payload);
    const err = (await ensureClaudeSidecar({
      fsImpl: fs,
      fetchFn,
      env: {},
      platform: "darwin-arm64",
      cacheRoot: "/cache",
      sleep: noSleep,
      expectedSha: wrongSha,
    }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/SHA256 mismatch for darwin-arm64 sidecar/);
    expect(err.message).toMatch(new RegExp(`expected=${wrongSha}`));
    expect(err.message).toMatch(new RegExp(`actual=${actualSha}`));
    expect(err.message).toMatch(/sidecar-pins\.ts/);
  });
});

describe("ensureClaudeSidecar — retry behavior", () => {
  it("gives up after 3 fetch failures", async () => {
    const { fs } = makeFakeFs();
    const { fetchFn, counter } = makeAlwaysFailingFetch();
    const err = (await ensureClaudeSidecar({
      fsImpl: fs,
      fetchFn,
      env: {},
      platform: "linux-x64",
      cacheRoot: "/cache",
      sleep: noSleep,
      expectedSha: "0".repeat(64),
    }).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/download failed after 3 attempts/);
    expect(counter.calls).toBe(3);
  });

  it("counts HTTP non-2xx as a retryable failure", async () => {
    const { fs } = makeFakeFs();
    const counter = { calls: 0 };
    const fetchFn: FetchFn = async () => {
      counter.calls += 1;
      return {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
    await expect(
      ensureClaudeSidecar({
        fsImpl: fs,
        fetchFn,
        env: {},
        platform: "linux-x64",
        cacheRoot: "/cache",
        sleep: noSleep,
        expectedSha: "0".repeat(64),
      }),
    ).rejects.toThrow(/download failed after 3 attempts/);
    expect(counter.calls).toBe(3);
  });

  it("recovers after a transient failure if the next attempt succeeds", async () => {
    const payload = new Uint8Array([1, 2, 3]);
    const sha = sha256Hex(payload);
    const counter = { calls: 0 };
    const fetchFn: FetchFn = async () => {
      counter.calls += 1;
      if (counter.calls === 1) {
        throw new Error("transient");
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => toArrayBuffer(payload),
      };
    };
    const { fs } = makeFakeFs();
    const res = await ensureClaudeSidecar({
      fsImpl: fs,
      fetchFn,
      env: {},
      platform: "linux-x64",
      cacheRoot: "/cache",
      sleep: noSleep,
      expectedSha: sha,
    });
    expect(counter.calls).toBe(2);
    expect(res.path).toMatch(/\/cache\/.*\/claude$/);
  });
});
