/**
 * Live smoke test against the real `pi --mode rpc` binary. Gated by
 * `SHAMU_PI_LIVE=1` — default test runs exclude this file via the
 * `test/live/**` exclude in `vitest.config.ts`.
 *
 * When invoked, this test:
 *   1. Resolves the `pi` binary (`vendorCliPath` → env `PI_CLI_PATH` →
 *      `Bun.which("pi")`).
 *   2. Spawns a real `pi --mode rpc --no-session` subprocess
 *      (ephemeral session so the on-disk state doesn't leak between runs).
 *   3. Sends a trivial prompt.
 *   4. Asserts the event stream contains `session_start` + at least one
 *      assistant_* + `turn_end`.
 *   5. Shuts down; expects the subprocess to be reaped cleanly.
 *
 * Prereqs (user-owned):
 *
 *   - Pi must be installed globally: `npm install -g @mariozechner/pi-coding-agent`
 *   - A provider must be configured, either via `pi login <provider>` or
 *     via an environment variable the Pi binary reads (e.g.
 *     `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …).
 *
 * Invoke with:
 *
 *   SHAMU_PI_LIVE=1 \
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *   bun run test -- --project pi
 *
 * The spawn-basic contract test is the hermetic version of this; this
 * test exists to catch "Pi wire shape drifted" regressions the fake
 * driver can't see.
 */

import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { createPiAdapter } from "../../src/index.ts";

const LIVE = process.env.SHAMU_PI_LIVE === "1";

describe.skipIf(!LIVE)("Pi live spawn", () => {
  it("spawns a real `pi --mode rpc`, runs a prompt, drains to turn_end", async () => {
    const adapter = createPiAdapter();
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: process.cwd(),
      vendorOpts: {
        ephemeralSession: true,
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
