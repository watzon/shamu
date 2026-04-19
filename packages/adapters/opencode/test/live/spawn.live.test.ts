/**
 * Live smoke test against the real `@opencode-ai/sdk`. Gated by
 * `SHAMU_OPENCODE_LIVE=1` — default test runs exclude this file via the
 * `test/live/**` exclude in `vitest.config.ts`.
 *
 * When invoked, this test:
 *   1. Calls `createOpencode()` to spawn a real local OpenCode server
 *   2. If `SHAMU_OPENCODE_PROVIDER` + `SHAMU_OPENCODE_API_KEY` are set,
 *      provisions that provider via `client.auth.set` at spawn time.
 *      Otherwise, trusts whatever OpenCode has already configured on this
 *      machine (`~/.local/share/opencode/auth.json`, written by
 *      `opencode auth login <provider>`). Most developers will have done
 *      this already; env vars are for CI / automation contexts.
 *   3. Sends a trivial prompt
 *   4. Asserts the event stream contains session_start, at least one
 *      assistant_*, and turn_end
 *   5. Shuts down; expects no zombie processes
 *
 * This is the end-to-end coverage the scripted contract suite deliberately
 * skips. Invoke with:
 *
 *   # Simplest (uses OpenCode's own stored auth):
 *   SHAMU_OPENCODE_LIVE=1 bun test packages/adapters/opencode/test/live/spawn.live.test.ts
 *
 *   # Override / CI style:
 *   SHAMU_OPENCODE_LIVE=1 \
 *   SHAMU_OPENCODE_PROVIDER=anthropic \
 *   SHAMU_OPENCODE_API_KEY=sk-ant-... \
 *   bun test packages/adapters/opencode/test/live/spawn.live.test.ts
 */

import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { createOpencodeAdapter } from "../../src/index.ts";

const LIVE = process.env.SHAMU_OPENCODE_LIVE === "1";
const PROVIDER = process.env.SHAMU_OPENCODE_PROVIDER;
const API_KEY = process.env.SHAMU_OPENCODE_API_KEY;
// Required when `SHAMU_OPENCODE_LIVE=1` and the attached server has no
// configured default. Point at one of your configured providers+models.
const PROVIDER_ID = process.env.SHAMU_OPENCODE_PROVIDER_ID ?? PROVIDER;
const MODEL_ID = process.env.SHAMU_OPENCODE_MODEL_ID;

describe.skipIf(!LIVE)("OpenCode live spawn", () => {
  it("spawns a real server, runs a prompt, drains to turn_end", async () => {
    if (!PROVIDER_ID || !MODEL_ID) {
      throw new Error(
        "SHAMU_OPENCODE_PROVIDER_ID + SHAMU_OPENCODE_MODEL_ID must be set (e.g. PROVIDER_ID=anthropic MODEL_ID=claude-sonnet-4-5). Your OpenCode install's auth.json already has keys; we just need to know which provider+model this run should use.",
      );
    }
    const adapter = createOpencodeAdapter();
    const authOverride =
      PROVIDER && API_KEY ? [{ providerId: PROVIDER, apiKey: API_KEY }] : undefined;
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: process.cwd(),
      vendorOpts: {
        ...(authOverride !== undefined ? { auth: authOverride } : {}),
        promptTimeoutMs: 60_000,
        providerID: PROVIDER_ID,
        modelID: MODEL_ID,
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
