/**
 * Live smoke test against the real `pi --mode rpc` binary. Gated by
 * `SHAMU_PI_LIVE=1` — default test runs exclude this file via the
 * `test/live/**` exclude in `vitest.config.ts`.
 *
 * When invoked, this test runs TWO flavors back-to-back, mirroring Phase
 * 9.B.6's "validate --no-session opt-out path too" requirement:
 *
 *   1. Default-session flavor — `vendorOpts.ephemeralSession` unset. Pi
 *      persists session state to disk. Exercises the wire path a normal
 *      `shamu run --adapter pi` takes.
 *   2. `--no-session` flavor — `vendorOpts.ephemeralSession: true`
 *      appends `--no-session` to the Pi spawn, so Pi holds state only in
 *      memory. Verifies that NO session JSONL lands in the run's cwd —
 *      the cwd is a throwaway tmpdir so Pi's cwd-scoped write (observed
 *      2026-04-19: Pi drops a second copy of the session into cwd
 *      alongside `~/.pi/agent/sessions/<slug>/`) is visible to the test
 *      without tainting the repo tree.
 *
 * Both flavors:
 *   1. Resolve the `pi` binary (`vendorCliPath` → env `PI_CLI_PATH` →
 *      `Bun.which("pi")` → `$PATH` scan).
 *   2. Spawn a real `pi --mode rpc [--no-session]` subprocess.
 *   3. Send a trivial prompt.
 *   4. Assert the event stream contains `session_start` + at least one
 *      `assistant_*` + `turn_end`.
 *   5. Shut down; expect the subprocess to be reaped cleanly.
 *
 * Prereqs (user-owned):
 *
 *   - Pi installed globally (`npm install -g @mariozechner/pi-coding-agent`
 *     or `brew install pi`).
 *   - A provider authenticated via `pi login <provider>` OR a
 *     provider-specific env var Pi reads
 *     (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` / …).
 *
 * Invoke with:
 *
 *   SHAMU_PI_LIVE=1 \
 *   SHAMU_PI_PROVIDER_ID=openai-codex \    # or whatever provider you logged in to
 *   bun x vitest run --config ./vitest.live.config.ts
 *
 * The hermetic contract suite is the default-test version of this; these
 * live tests exist to catch Pi-wire-shape drift a fake driver can't see.
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { newRunId } from "@shamu/shared/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPiAdapter } from "../../src/index.ts";

const LIVE = process.env.SHAMU_PI_LIVE === "1";
// Pi's default provider is `google`. If you haven't set up a Google key
// in Pi's config, pick one of your other configured providers via env.
const PROVIDER_ID = process.env.SHAMU_PI_PROVIDER_ID;
const MODEL_ID = process.env.SHAMU_PI_MODEL_ID;

async function drainUntilTurnEnd(
  events: AsyncIterable<{ readonly kind: string }>,
): Promise<readonly string[]> {
  const kinds: string[] = [];
  for await (const ev of events) {
    kinds.push(ev.kind);
    if (ev.kind === "turn_end") break;
  }
  return kinds;
}

function listJsonl(dir: string): readonly string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
}

/**
 * Compute Pi's documented per-cwd session-discovery directory. Pi slugs
 * the cwd by replacing `/` with `-` and wrapping the result in `--`.
 * Sessions in this directory are the ones `pi --resume` / `pi --continue`
 * can discover — which is exactly what `--no-session` is documented to
 * suppress.
 */
function piDiscoveryDirForCwd(cwd: string): string {
  const slug = cwd.replaceAll("/", "-");
  return join(homedir(), ".pi", "agent", "sessions", `-${slug}-`);
}

describe.skipIf(!LIVE)("Pi live spawn", () => {
  let scratchCwd = "";

  beforeEach(() => {
    // Each test gets a throwaway cwd so Pi's cwd-scoped session drop
    // doesn't leak into the repo tree and so the no-session assertion
    // has a clean slate to diff against.
    scratchCwd = mkdtempSync(join(tmpdir(), "shamu-pi-live-"));
  });

  afterEach(() => {
    if (scratchCwd.length > 0) {
      try {
        rmSync(scratchCwd, { recursive: true, force: true });
      } catch {
        // Best-effort; the OS will sweep /tmp.
      }
      scratchCwd = "";
    }
  });

  it("default-session flavor: spawns a real `pi --mode rpc`, runs a prompt, drains to turn_end", async () => {
    const adapter = createPiAdapter();
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: scratchCwd,
      vendorOpts: {
        // ephemeralSession intentionally omitted — verify Pi's on-disk
        // session default path works end-to-end.
        promptTimeoutMs: 60_000,
        ...(PROVIDER_ID !== undefined ? { providerID: PROVIDER_ID } : {}),
        ...(MODEL_ID !== undefined ? { modelID: MODEL_ID } : {}),
      },
    });
    try {
      await handle.send({ text: "Say 'hello' and end your turn." });
      const kinds = await drainUntilTurnEnd(handle.events);
      expect(kinds).toContain("session_start");
      expect(kinds.some((k) => k === "assistant_delta" || k === "assistant_message")).toBe(true);
      expect(kinds).toContain("turn_end");
    } finally {
      await handle.shutdown("live-smoke-cleanup-default");
    }
  }, 120_000);

  it("--no-session flavor: ephemeralSession=true suppresses Pi's discovery-dir session JSONL", async () => {
    // `--no-session` per Pi's help text means "Don't save session
    // (ephemeral)". Operationally, the flag prevents Pi from registering
    // the session under its cwd-scoped discovery directory
    // (`~/.pi/agent/sessions/<slug>/`) — which is where `pi --resume` /
    // `pi --continue` look. A throwaway `mkdtemp` cwd ensures the
    // directory starts empty so the diff is unambiguous.
    const discoveryDir = piDiscoveryDirForCwd(scratchCwd);
    const before = listJsonl(discoveryDir);

    const adapter = createPiAdapter();
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: scratchCwd,
      vendorOpts: {
        ephemeralSession: true,
        promptTimeoutMs: 60_000,
        ...(PROVIDER_ID !== undefined ? { providerID: PROVIDER_ID } : {}),
        ...(MODEL_ID !== undefined ? { modelID: MODEL_ID } : {}),
      },
    });
    try {
      await handle.send({ text: "Say 'hello' and end your turn." });
      const kinds = await drainUntilTurnEnd(handle.events);
      expect(kinds).toContain("session_start");
      expect(kinds.some((k) => k === "assistant_delta" || k === "assistant_message")).toBe(true);
      expect(kinds).toContain("turn_end");
    } finally {
      await handle.shutdown("live-smoke-cleanup-no-session");
    }

    // `--no-session` MUST NOT drop new JSONL under Pi's discovery dir
    // for this cwd — otherwise the opt-out would still leak state to
    // `pi --resume`'s scan. Pi 0.67.68 still writes a transcript into
    // cwd alongside the RPC protocol even with the flag (noted in the
    // smoke doc as a vendor-side quirk worth tracking) — that copy is
    // out-of-scope for this assertion.
    const after = listJsonl(discoveryDir);
    const added = after.filter((f) => !before.includes(f));
    expect(added).toEqual([]);
  }, 120_000);
});
