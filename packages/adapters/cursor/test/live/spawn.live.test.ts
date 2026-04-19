/**
 * Live smoke test against the real `cursor-agent acp` binary. Gated by
 * `SHAMU_CURSOR_LIVE=1` — default test runs exclude this file via the
 * `test/live/**` exclude in `vitest.config.ts`.
 *
 * When invoked, this test:
 *   1. Resolves the `cursor-agent` binary (`vendorCliPath` → env
 *      `CURSOR_AGENT_PATH` → `~/.local/bin/agent`)
 *   2. Spawns a real `cursor-agent acp` subprocess
 *   3. Authenticates via `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` env (or
 *      relies on Cursor Desktop's already-logged-in token)
 *   4. Sends a trivial prompt
 *   5. Asserts the event stream contains session_start + at least one
 *      assistant_* + turn_end
 *   6. Asserts NO `unknown_update_kind` errors surface — regression guard
 *      for the 9.B.3 smoke that added `available_commands_update` and
 *      `session_info_update` to the ignore list.
 *   7. Shuts down; expects the subprocess to be reaped cleanly
 *
 * Invoke with:
 *
 *   SHAMU_CURSOR_LIVE=1 \
 *   CURSOR_API_KEY=sk-cursor-... \        # or CURSOR_AUTH_TOKEN, or rely on Cursor Desktop
 *   bun run test -- --project cursor
 *
 * ### Runtime: requires Bun
 *
 * `@shamu/protocol-acp`'s stdio transport spawns the subprocess via
 * `Bun.spawn`. Vitest runs its test files under Node even when launched
 * via `bun x vitest`, so the test must be invoked under the Bun runtime
 * directly (`bun test …`) rather than through vitest. The workspace
 * entry point is `bun test -t 'Cursor live spawn' packages/adapters/cursor/test/live/spawn.live.test.ts`
 * with `SHAMU_CURSOR_LIVE=1` set. Sibling ACP adapters (Gemini) have the
 * same constraint.
 *
 * The spawn-basic contract test is the hermetic version of this; this test
 * exists to catch "the ACP wire-shape drifted" regressions that the fake
 * driver can't see.
 */

import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { createCursorAdapter } from "../../src/index.ts";

const LIVE = process.env.SHAMU_CURSOR_LIVE === "1";

describe.skipIf(!LIVE)("Cursor live spawn", () => {
  it("spawns a real cursor-agent acp, runs a prompt, drains to turn_end", async () => {
    const adapter = createCursorAdapter();
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
      const unknownKinds: string[] = [];
      for await (const ev of handle.events) {
        kinds.push(ev.kind);
        if (ev.kind === "error" && ev.errorCode === "unknown_update_kind") {
          unknownKinds.push(ev.message);
        }
        if (ev.kind === "turn_end") break;
      }
      expect(kinds).toContain("session_start");
      expect(kinds.some((k) => k === "assistant_delta" || k === "assistant_message")).toBe(true);
      expect(kinds).toContain("turn_end");
      // Regression guard: every session/update kind Cursor emits today should
      // be projected or explicitly ignored. A new unknown kind from the
      // vendor shows up here with the full error message.
      expect(unknownKinds).toEqual([]);
    } finally {
      await handle.shutdown("live-smoke-cleanup");
    }
  }, 120_000);
});
