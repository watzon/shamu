/**
 * Live smoke test against the real `amp -x --stream-json --stream-json-input`
 * binary. Gated by `SHAMU_AMP_LIVE=1` — default test runs exclude this file
 * via the `test/live/**` exclude in `vitest.config.ts`.
 *
 * When invoked, this test:
 *   1. Resolves the `amp` binary (`vendorCliPath` → env `AMP_CLI_PATH` →
 *      `Bun.which("amp")` → `$PATH`)
 *   2. Spawns a real `amp -x --stream-json --stream-json-input` subprocess
 *   3. Authenticates via `AMP_API_KEY` env or the keychain-persisted token
 *      from a pre-ran `amp login`
 *   4. Sends a trivial prompt
 *   5. Asserts the event stream contains session_start + at least one
 *      assistant_* + turn_end
 *   6. Shuts down; expects the subprocess to be reaped cleanly
 *
 * Invoke with:
 *
 *   SHAMU_AMP_LIVE=1 \
 *   AMP_API_KEY=... \               # or rely on pre-ran `amp login`
 *   bun run test -- --project amp
 *
 * The spawn-basic contract test is the hermetic version of this; this test
 * exists to catch "the Amp wire-shape drifted" regressions that the fake
 * driver can't see. Note: the parent user does NOT have Amp installed
 * locally as of 2026-04-18; this test is primarily for CI + other dev
 * machines.
 */

import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { createAmpAdapter } from "../../src/index.ts";

const LIVE = process.env.SHAMU_AMP_LIVE === "1";

describe.skipIf(!LIVE)("Amp live spawn", () => {
  it("spawns a real amp -x --stream-json --stream-json-input, runs a prompt, drains to turn_end", async () => {
    const adapter = createAmpAdapter();
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: process.cwd(),
      vendorOpts: {
        promptTimeoutMs: 60_000,
      },
    });
    try {
      await handle.send({ text: "Say 'hello' and end your turn." });
      const kinds: string[] = [];
      for await (const ev of handle.events) {
        kinds.push(ev.kind);
        if (ev.kind === "turn_end") break;
      }
      expect(kinds).toContain("session_start");
      expect(kinds.some((k) => k === "assistant_delta" || k === "assistant_message")).toBe(true);
      expect(kinds).toContain("turn_end");
    } finally {
      await handle.shutdown("live-smoke-cleanup");
    }
  }, 120_000);
});
