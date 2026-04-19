/**
 * Smoke test for `scripts/build-release.ts`.
 *
 * Gated on the env flag `SHAMU_RELEASE_BUILD_SMOKE=1` so the normal
 * `bun run test` doesn't spend ~20+ seconds running an actual
 * `bun build --compile` every time. Enable locally or in a release-gate
 * CI job:
 *
 *   SHAMU_RELEASE_BUILD_SMOKE=1 bun test scripts/build-release.test.ts
 *
 * When enabled, the test picks the current host target, invokes
 * `buildOneTarget` against a temp outdir, and asserts:
 *   - the compiled binary file exists
 *   - the `.sha256` sidecar was written and matches
 *   - the file has the executable bit set (owner)
 *
 * When disabled, `bun test` treats a test-file containing zero tests as a
 * pass (see `bun test` docs), so wrapping the `describe` block in a
 * runtime gate keeps the suite green without adding a skip helper.
 */

import { describe, expect, test } from "bun:test";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOneTarget, resolveHostTarget } from "./build-release.ts";

const GATE = process.env.SHAMU_RELEASE_BUILD_SMOKE === "1";

const describeOrSkip = GATE ? describe : describe.skip;

describeOrSkip("scripts/build-release smoke", () => {
  test("produces a compiled binary and matching sha256 for the host target", () => {
    const target = resolveHostTarget();
    const outdir = mkdtempSync(`${tmpdir()}/shamu-release-smoke-`);
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const entrypoint = resolve(repoRoot, "apps/cli/src/index.ts");
    try {
      const result = buildOneTarget({
        target,
        outdir,
        entrypoint,
        repoRoot,
        emit: () => {
          // suppress NDJSON during the test so runner output stays clean
        },
      });
      const stat = statSync(result.outfile);
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBeGreaterThan(1_000_000);
      // executable bit (owner)
      accessSync(result.outfile, constants.X_OK);
      const sha = readFileSync(`${result.outfile}.sha256`, "utf8").trim();
      expect(sha.split(/\s+/)[0]).toBe(result.sha256);
    } finally {
      try {
        rmSync(outdir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; CI temp dirs get garbage-collected either way
      }
    }
  }, 120_000);
});
