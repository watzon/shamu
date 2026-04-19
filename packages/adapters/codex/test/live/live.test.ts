/**
 * Live-mode Codex adapter tests.
 *
 * These tests drive the REAL `@openai/codex-sdk` against a pre-
 * authenticated local `codex` CLI (or a CODEX_API_KEY env var). They
 * are gated behind `SHAMU_CODEX_LIVE=1` — both in-test via
 * `describe.skip` when the gate is off AND via a
 * `vitest.config.ts` exclude of `test/live/**` when
 * `SHAMU_CODEX_LIVE !== "1"` — so a routine `bun run test` stays
 * hermetic on machines without a Codex CLI.
 *
 * To run:
 *   SHAMU_CODEX_LIVE=1 SHAMU_CODEX_CLI=/opt/homebrew/bin/codex \
 *     bun run --cwd packages/adapters/codex test
 *
 * Expected env:
 *   - `SHAMU_CODEX_LIVE=1` — intent gate.
 *   - Either `CODEX_API_KEY` set, OR a path to a pre-authenticated
 *     Codex CLI provided via `SHAMU_CODEX_CLI=/opt/homebrew/bin/codex`
 *     (or similar). The tests prefer the CLI path when both are
 *     present, matching `resolveCodexAuth` precedence.
 *
 * Assertions focus on the Phase 9.B.1 live-smoke invariants:
 *   1. A simple turn reaches `turn_end` with `stopReason=completed`.
 *   2. A non-git `cwd` still completes (regression guard for the
 *      `skipGitRepoCheck: true` wiring — Codex CLI's trusted-dir
 *      check would otherwise exit 0 with zero events).
 *
 * HANDOFF followup #3: live-mode tests exercise real `subprocess.ts`
 * paths indirectly — the SDK spawns the CLI itself, so this is the
 * only place the real process-spawn path gets exercised in the codex
 * package.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRunId } from "@shamu/shared/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/index.ts";

const LIVE_GATE = process.env.SHAMU_CODEX_LIVE === "1";
const CLI_PATH = process.env.SHAMU_CODEX_CLI;
const API_KEY = process.env.CODEX_API_KEY;
const AUTH_AVAILABLE = Boolean(CLI_PATH) || Boolean(API_KEY);

const describeLive = LIVE_GATE && AUTH_AVAILABLE ? describe : describe.skip;

let worktree: string;

beforeAll(() => {
  worktree = mkdtempSync(join(tmpdir(), "shamu-codex-live-"));
});

afterAll(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describeLive("CodexAdapter (LIVE)", () => {
  it("spawn + simple turn reaches turn_end with stopReason=completed", async () => {
    const adapter = new CodexAdapter();
    const spawnOpts = {
      cwd: worktree,
      runId: newRunId(),
      ...(CLI_PATH ? { vendorCliPath: CLI_PATH } : {}),
    };
    const handle = await adapter.spawn(spawnOpts);
    try {
      await handle.send({ text: "Respond with the single word 'pong' and stop." });
      let terminalKind: string | undefined;
      let terminalStop: string | undefined;
      for await (const ev of handle.events) {
        if (ev.kind === "turn_end") {
          terminalKind = ev.kind;
          terminalStop = ev.stopReason;
          break;
        }
      }
      expect(terminalKind).toBe("turn_end");
      expect(terminalStop).toBe("completed");
    } finally {
      await handle.shutdown("live-test-done");
    }
  }, 60_000);

  it("completes in a non-git cwd (skipGitRepoCheck regression guard)", async () => {
    // Fresh tmpdir — deliberately NOT git-init. Before the Phase 9.B.1
    // fix this call would hang forever: the Codex CLI refused to run
    // in a non-trusted directory, exited 0 with zero events, and the
    // adapter's event queue never closed.
    const nongit = mkdtempSync(join(tmpdir(), "shamu-codex-live-nongit-"));
    const adapter = new CodexAdapter();
    const spawnOpts = {
      cwd: nongit,
      runId: newRunId(),
      ...(CLI_PATH ? { vendorCliPath: CLI_PATH } : {}),
    };
    const handle = await adapter.spawn(spawnOpts);
    try {
      await handle.send({ text: "Reply with one word: ok" });
      let sawTurnEnd = false;
      for await (const ev of handle.events) {
        if (ev.kind === "turn_end") {
          sawTurnEnd = true;
          break;
        }
      }
      expect(sawTurnEnd).toBe(true);
    } finally {
      await handle.shutdown("live-test-done");
      rmSync(nongit, { recursive: true, force: true });
    }
  }, 60_000);
});
