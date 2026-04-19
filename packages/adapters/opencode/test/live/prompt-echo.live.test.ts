/**
 * Live regression — user's prompt text MUST NOT reappear as an
 * `assistant_delta` / `assistant_message` on the normalized event stream.
 *
 * Phase 9.B.2 discovery: the projector previously emitted a vendor
 * `message.part.updated(type: text)` for the user's prompt message (the
 * server echoes the prompt as a text part on the SSE stream). Without
 * filtering, the orchestrator saw the prompt announced as assistant output
 * BEFORE `session_start`. The fix tracks user-message ids via
 * `message.updated(role: "user")` and buffers privileged (text / reasoning)
 * parts until the role is known.
 *
 * This test sends a unique-string prompt, drains events to `turn_end`, and
 * asserts that no `assistant_*` event carries the prompt marker verbatim.
 * Gated by `SHAMU_OPENCODE_LIVE=1`; required env is the same as
 * `spawn.live.test.ts`.
 */

import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { createOpencodeAdapter } from "../../src/index.ts";

const LIVE = process.env.SHAMU_OPENCODE_LIVE === "1";
const PROVIDER = process.env.SHAMU_OPENCODE_PROVIDER;
const API_KEY = process.env.SHAMU_OPENCODE_API_KEY;
const PROVIDER_ID = process.env.SHAMU_OPENCODE_PROVIDER_ID ?? PROVIDER;
const MODEL_ID = process.env.SHAMU_OPENCODE_MODEL_ID;

// Unique sentinel so a substring match can't be fooled by common English.
// Embedded in the prompt; assistant is instructed NOT to echo. Even if it
// does, the failure is "assistant chose to echo" not "projector leaked" —
// the sentinel lets us tell those apart.
const PROMPT_MARKER = "SHAMU_BROMIUM_SENTINEL_9B2";

describe.skipIf(!LIVE)("OpenCode live — user prompt does not leak as assistant output", () => {
  it("drains session_start BEFORE any assistant delta + marker never surfaces", async () => {
    if (!PROVIDER_ID || !MODEL_ID) {
      throw new Error(
        "SHAMU_OPENCODE_PROVIDER_ID + SHAMU_OPENCODE_MODEL_ID must be set (e.g. PROVIDER_ID=opencode MODEL_ID=claude-haiku-4-5).",
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
      const promptText = `Reply with just 'ok'. Do not repeat the following marker: ${PROMPT_MARKER}`;
      await handle.send({ text: promptText });

      const kinds: string[] = [];
      const assistantTexts: string[] = [];
      let firstSessionStartIndex = -1;
      for await (const ev of handle.events) {
        const index = kinds.length;
        kinds.push(ev.kind);
        if (ev.kind === "session_start" && firstSessionStartIndex === -1) {
          firstSessionStartIndex = index;
        }
        if (ev.kind === "assistant_delta" || ev.kind === "assistant_message") {
          assistantTexts.push(ev.text);
        }
        if (ev.kind === "turn_end") break;
      }

      // Gate 1: session_start lands before any assistant_* event.
      expect(firstSessionStartIndex).toBeGreaterThanOrEqual(0);
      const firstAssistantIndex = kinds.findIndex(
        (k) => k === "assistant_delta" || k === "assistant_message",
      );
      if (firstAssistantIndex !== -1) {
        expect(firstSessionStartIndex).toBeLessThan(firstAssistantIndex);
      }

      // Gate 2: the prompt marker must not appear verbatim in any emitted
      // assistant event. If it does, either (a) the projector regressed and
      // is re-emitting user parts, or (b) the model chose to echo despite
      // being told not to. Both are worth surfacing; the model echo is
      // rare and only occurs when the model misreads the instruction.
      for (const text of assistantTexts) {
        expect(text).not.toContain(PROMPT_MARKER);
      }

      // Gate 3: normal completion.
      expect(kinds).toContain("turn_end");
    } finally {
      await handle.shutdown("prompt-echo-live-cleanup");
    }
  }, 120_000);
});
