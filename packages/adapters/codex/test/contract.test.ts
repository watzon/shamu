/**
 * Run the shared adapter contract suite against a Codex adapter backed by
 * a scripted SDK double. Live vendor calls are NOT made here — the
 * fake-thread selects the right script based on the prompt text, the way
 * the real Codex agent would react.
 *
 * Scenarios self-skip when the manifest declares a feature off. Codex's
 * current manifest:
 *   resume: true           → resume-warm runs
 *   fork: false            → no fork scenario in the suite
 *   interrupt: cooperative → interrupt runs
 *   patchVisibility: events  → patch-metadata runs
 *   streaming: events      → tool-call-visibility runs
 *   usageReporting: per-turn → set-model + usage-and-cost run
 *   costReporting: subscription → usage-and-cost asserts usd=null
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { AgentHandle } from "@shamu/adapters-base";
import type { AdapterUnderTest } from "@shamu/adapters-base/contract";
import { runAdapterContractSuite } from "@shamu/adapters-base/contract";
import { afterAll, beforeAll } from "vitest";
import { CODEX_CAPABILITIES, CodexAdapter, type CodexLike, type ThreadLike } from "../src/index.ts";
import {
  echoScript,
  FakeCodex,
  FakeThread,
  failScript,
  longScript,
  patchScript,
  pathScopeProbeScript,
  readmeToolScript,
  shellGateProbeScript,
  type TurnStep,
} from "./fake-thread.ts";

let rootDir: string;
let priorCodexApiKey: string | undefined;

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), "shamu-codex-contract-"));
  // The `resume-warm` scenario calls `adapter.resume(sid, ctx.spawnOpts)`
  // using the harness's spawnOpts directly — our factory can't inject
  // `vendorCliPath` into that call. Plant a fake API key in the env so
  // `resolveCodexAuth` picks the api-key branch; the codexFactory is
  // stubbed to a FakeCodex anyway, so no real auth ever happens.
  priorCodexApiKey = process.env.CODEX_API_KEY;
  process.env.CODEX_API_KEY = "sk-codex-contract-test-fake";
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
  if (priorCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
  else process.env.CODEX_API_KEY = priorCodexApiKey;
});

type StepScript = (input: string, signal: AbortSignal | undefined) => readonly TurnStep[];

/**
 * Pick the right scripted stream based on prompt text. Mirrors the echo
 * adapter's `chooseScript` so the contract-suite fixtures trigger the
 * vendor paths they need to trigger (tool-call, patch, interrupt, fail,
 * secret, multi-turn, hello).
 */
function chooseScript(input: string): StepScript {
  const lower = input.toLowerCase();
  if (lower.includes("definitely-does-not-exist")) return failScript as StepScript;
  if (lower.includes("count slowly")) return longScript;
  if (lower.includes("create a file")) return patchScript as StepScript;
  if (/read\s+.+readme\.md/i.test(input)) return readmeToolScript as StepScript;
  // G4 / G5 probes — fail-loud for codex (`scriptProbe: true`). The fake
  // driver emits a rule-breaking `item.started`; the real CodexHandle's
  // `decidePermission` pre-dispatch gate fires the rejection.
  if (input.includes("CONTRACT_PROBE_PATH_SCOPE_ESCAPE")) return pathScopeProbeScript as StepScript;
  if (input.includes("CONTRACT_PROBE_SHELL_SUBSTITUTION"))
    return shellGateProbeScript as StepScript;
  return echoScript as StepScript;
}

/**
 * A FakeThread variant whose `runStreamed` dispatches to a fresh script
 * per turn based on the input text. The contract suite hands each
 * scenario its own handle; we share one FakeCodex factory and let each
 * Thread pick the right script per-call.
 */
class RoutingFakeThread extends FakeThread {
  constructor(id: string | null) {
    super({ id, scripts: [echoScript as StepScript] });
  }
  override async runStreamed(
    input: string,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<ThreadEvent> }> {
    const script = chooseScript(input);
    // Swap the underlying scripts list for THIS call. We don't persist
    // across calls because the next send() may be a different prompt.
    const self = this as unknown as { scripts: readonly StepScript[] };
    const prior = self.scripts;
    self.scripts = [script];
    (this as unknown as { turnIndex: number }).turnIndex = 0;
    const result = await super.runStreamed(input, turnOptions);
    self.scripts = prior;
    return result;
  }
}

const adapter = new CodexAdapter({
  codexFactory: (_sdkOpts): CodexLike => {
    const factory = (kind: "start" | "resume", id: string | null): ThreadLike =>
      new RoutingFakeThread(kind === "resume" ? id : null);
    return new FakeCodex(factory);
  },
});

const aut: AdapterUnderTest = {
  adapter,
  vendor: adapter.vendor,
  capabilities: CODEX_CAPABILITIES,
  factory: async (ctx) =>
    adapter.spawn({
      ...ctx.spawnOpts,
      vendorCliPath: "/fake/codex",
    }),
  teardown: async (handle: AgentHandle) => {
    try {
      await handle.shutdown("contract-teardown");
    } catch {
      // Idempotent in the Codex handle; swallow.
    }
  },
  worktreeFor: async (scenarioName) => {
    const dir = join(rootDir, scenarioName.replace(/[^a-z0-9_-]/gi, "_"));
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  // Phase 7.G migration (2026-04-19): codex's CodexHandle runs
  // `decidePermission` on every `item.started` (file_change + command_execution)
  // before projecting the event, so both G4 and G5 gates are enforceable
  // at adapter level. Opt in to fail-loud mode — the fake thread emits
  // rule-breaking items; the handle's own gate fires the rejection.
  scriptProbe: (probe) => probe === "path-scope" || probe === "shell-gate",
};

// HANDOFF followup #5 — STRESS_ITERATIONS lives on the scenario itself but
// Vitest's per-it timeout is the other half of that knob. A user who sets
// STRESS_ITERATIONS=100 expects the stress-no-leaks scenario to walk 100
// iterations; we bump the overall per-scenario timeout to give it room.
const stressIter = Number.parseInt(process.env.STRESS_ITERATIONS ?? "", 10) || 10;
const timeoutMs = Math.max(5_000, stressIter * 200);

runAdapterContractSuite(aut, { timeoutMs });
