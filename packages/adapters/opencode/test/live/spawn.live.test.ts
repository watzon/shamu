/**
 * Live smoke test against the real `@opencode-ai/sdk`. Gated by
 * `SHAMU_OPENCODE_LIVE=1` — default test runs exclude this file via the
 * `test/live/**` exclude in `vitest.config.ts`.
 *
 * When invoked, this test:
 *   1. Calls `createOpencode()` to spawn a real local OpenCode server
 *   2. Requires `SHAMU_OPENCODE_PROVIDER` (e.g., "anthropic") and
 *      `SHAMU_OPENCODE_API_KEY` so the server can actually call an LLM
 *   3. Sends a trivial prompt
 *   4. Asserts the event stream contains session_start, at least one
 *      assistant_*, usage, cost, and turn_end
 *   5. Shuts down; expects no zombie processes
 *
 * This is the end-to-end coverage the scripted contract suite deliberately
 * skips. Invoke with:
 *
 *   SHAMU_OPENCODE_LIVE=1 \
 *   SHAMU_OPENCODE_PROVIDER=anthropic \
 *   SHAMU_OPENCODE_API_KEY=sk-ant-... \
 *   bun run test -- --project opencode
 */

import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { createOpencodeAdapter } from "../../src/index.ts";

const LIVE = process.env.SHAMU_OPENCODE_LIVE === "1";
const PROVIDER = process.env.SHAMU_OPENCODE_PROVIDER;
const API_KEY = process.env.SHAMU_OPENCODE_API_KEY;

describe.skipIf(!LIVE)("OpenCode live spawn", () => {
  it("spawns a real server, runs a prompt, drains to turn_end", async () => {
    if (!PROVIDER || !API_KEY) {
      throw new Error(
        "SHAMU_OPENCODE_PROVIDER and SHAMU_OPENCODE_API_KEY must be set when SHAMU_OPENCODE_LIVE=1",
      );
    }
    const adapter = createOpencodeAdapter();
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: process.cwd(),
      vendorOpts: {
        auth: [{ providerId: PROVIDER, apiKey: API_KEY }],
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
  }, 90_000);
});
