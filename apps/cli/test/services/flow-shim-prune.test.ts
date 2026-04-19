/**
 * Unit tests for `pruneFlowShims`.
 */

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneFlowShims } from "../../src/services/flow-shim-prune.ts";

function touch(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
}

function setMtime(path: string, mtimeMs: number): void {
  const time = mtimeMs / 1000;
  utimesSync(path, time, time);
}

describe("pruneFlowShims", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shim-prune-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns zero counts for a non-existent directory without throwing", async () => {
    const result = await pruneFlowShims({ dir: join(dir, "does-not-exist") });
    expect(result).toEqual({ removed: 0, scanned: 0, errors: 0 });
  });

  it("removes files older than maxAgeMs and keeps young ones", async () => {
    const now = 1_000_000_000_000; // ~2001
    const oneHour = 60 * 60 * 1000;
    const oldFile = join(dir, "old.js");
    const youngFile = join(dir, "young.js");
    touch(oldFile, "// old");
    touch(youngFile, "// young");
    // Old: 2 days prior. Young: 10 min prior.
    setMtime(oldFile, now - 2 * 24 * oneHour);
    setMtime(youngFile, now - 10 * 60 * 1000);

    const result = await pruneFlowShims({
      dir,
      maxAgeMs: 24 * oneHour,
      now: () => now,
    });
    expect(result.removed).toBe(1);
    expect(result.scanned).toBe(2);
    expect(result.errors).toBe(0);

    // The young file is still there; the old one is gone. We test by
    // re-running with a much older threshold — it should find just the
    // young one.
    const second = await pruneFlowShims({
      dir,
      maxAgeMs: 1,
      now: () => now,
    });
    expect(second.removed).toBe(1);
    expect(second.scanned).toBe(1);
  });

  it("leaves subdirectories alone", async () => {
    const now = 2_000_000_000_000;
    const nestedDir = join(dir, "nested");
    // Use node's own mkdirSync via writeFileSync? Use mkdirSync.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(nestedDir);

    const result = await pruneFlowShims({
      dir,
      maxAgeMs: 1,
      now: () => now,
    });
    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("default max age is 24h", async () => {
    const now = Date.now();
    const old = join(dir, "old.js");
    const young = join(dir, "young.js");
    touch(old, "");
    touch(young, "");
    setMtime(old, now - 25 * 60 * 60 * 1000);
    setMtime(young, now - 1 * 60 * 60 * 1000);

    const result = await pruneFlowShims({ dir });
    expect(result.removed).toBe(1);
  });
});
