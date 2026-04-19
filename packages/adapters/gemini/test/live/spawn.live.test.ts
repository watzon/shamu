/**
 * Live smoke test against the real `gemini --acp` binary. Gated by
 * `SHAMU_GEMINI_LIVE=1` — default test runs exclude this file via the
 * `test/live/**` exclude in `vitest.config.ts`.
 *
 * When invoked, this test:
 *   1. Resolves the `gemini` binary (`vendorCliPath` → env
 *      `GEMINI_CLI_PATH` → `$PATH` lookup for `gemini`)
 *   2. Spawns a real `gemini --acp` subprocess
 *   3. Authenticates via `GEMINI_API_KEY` / `GOOGLE_AI_API_KEY` env, or
 *      relies on a pre-ran `gemini /login` keychain credential
 *   4. Sends a trivial prompt
 *   5. Asserts the event stream contains session_start + at least one
 *      assistant_* + turn_end
 *   6. Shuts down; expects the subprocess to be reaped cleanly
 *
 * Invoke with:
 *
 *   SHAMU_GEMINI_LIVE=1 \
 *   GEMINI_API_KEY=... \          # or GOOGLE_AI_API_KEY, or rely on `gemini /login`
 *   bun run test -- --project gemini
 *
 * The spawn-basic contract test is the hermetic version of this; this test
 * exists to catch "the ACP wire-shape drifted" regressions that the fake
 * driver can't see, including the stdout-corruption behavior upstream
 * (gemini-cli#22647).
 */

import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { createGeminiAdapter } from "../../src/index.ts";

const LIVE = process.env.SHAMU_GEMINI_LIVE === "1";

describe.skipIf(!LIVE)("Gemini live spawn", () => {
  it("spawns a real gemini --acp, runs a prompt, drains to turn_end", async () => {
    const adapter = createGeminiAdapter();
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: process.cwd(),
      vendorOpts: {
        promptTimeoutMs: 120_000,
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
  }, 180_000);
});
