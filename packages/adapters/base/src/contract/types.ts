/**
 * Contract-suite public types.
 *
 * An `AdapterUnderTest` is the small factory + teardown bundle a downstream
 * Vitest suite passes into `runAdapterContractSuite(...)`. The suite calls
 * `factory(scenario)` to get a handle for each scenario and calls `teardown`
 * after every scenario so the adapter can reap subprocesses / clean worktrees
 * / etc.
 */

import type { AgentAdapter, AgentHandle, SpawnOpts, UserTurn } from "../adapter.ts";
import type { Capabilities } from "../capabilities.ts";

/**
 * Everything a scenario receives. Scenarios are responsible for reading
 * `adapter.capabilities` and self-skipping when a feature is declared off.
 */
export interface ScenarioContext {
  /** Human label of the scenario ("spawn-basic", "interrupt", …). */
  readonly name: string;
  /** The live adapter being tested. */
  readonly adapter: AgentAdapter;
  /**
   * Per-scenario spawn opts. The harness sets `cwd` to a throwaway worktree.
   * Scenarios may extend with their own fields.
   */
  readonly spawnOpts: SpawnOpts;
  /**
   * A canonical "say hello" user turn. Scenarios that need richer prompts
   * (multi-turn, tool-forcing) construct their own; this one is shared.
   */
  readonly helloTurn: UserTurn;
  /**
   * Maximum time a scenario is allowed to run. Enforced by the harness via
   * Vitest's `timeout`; surfaced here so scenarios can inform their own
   * internal timeouts (e.g., the interrupt scenario waits up to 10s).
   */
  readonly timeoutMs: number;
  /**
   * A caller-supplied logger. Defaults to `console`-ish, but suites may
   * inject something quieter.
   */
  readonly log: ContractLogger;
  /**
   * Query whether the adapter-under-test's fake driver scripts a named
   * probe (see `ScriptProbeId`). Scenarios that target a G4/G5 probe use
   * this to flip between warn-only (legacy) and fail-loud (modern)
   * assertions. Returns `false` when the adapter didn't declare
   * `scriptProbe` at all, or when it declared the probe as unsupported.
   */
  readonly scriptProbeSupported: (probe: ScriptProbeId) => boolean;
}

export interface ContractLogger {
  info(msg: string, extra?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, extra?: Readonly<Record<string, unknown>>): void;
  error(msg: string, extra?: Readonly<Record<string, unknown>>): void;
}

/** Factory that produces a handle per scenario. */
export type AdapterFactory = (ctx: ScenarioContext) => Promise<AgentHandle>;

/**
 * Downstream Vitest suites pass one of these. `teardown` MUST be idempotent:
 * scenarios that already called `handle.shutdown()` still go through it.
 */
export interface AdapterUnderTest {
  readonly adapter: AgentAdapter;
  /** Vendor string for nicer test output. */
  readonly vendor: string;
  readonly capabilities: Capabilities;
  /**
   * Produce a fresh handle. The harness calls this once per scenario.
   *
   * The factory MAY return a resumed handle for the `resume-warm` scenario
   * (the scenario passes its own `sessionId` via `scenario.spawnOpts.vendorOpts`)
   * — the base factory shouldn't assume spawn-only.
   */
  readonly factory: AdapterFactory;
  /** Clean up per-scenario resources. */
  readonly teardown: (handle: AgentHandle) => Promise<void>;
  /**
   * Produce a worktree path for this scenario. Scenarios mutate files under
   * this path; the harness deletes it on teardown.
   */
  readonly worktreeFor: (scenarioName: string) => Promise<string>;
  /** Optional: opt out of specific scenarios by name. */
  readonly skip?: readonly string[];
  /**
   * Opt-in fake-driver probe declaration for the path-scope and shell-AST
   * scenarios (G4 / G5). Adapters whose fake driver DOES script a synthetic
   * rule-breaking tool-call in response to the probe prompt should declare
   * the supported probe ids here — the scenario switches from warn-only to
   * fail-loud when a probe is declared supported.
   *
   * Defaulting `scriptProbe` to `undefined` preserves the existing
   * warn-only behavior for echo / claude / codex / opencode; their unit
   * tests cover the gate directly, so the contract suite warning is the
   * correct signal. Phase 7.G's capability-matrix work may migrate those
   * drivers to `scriptProbe` en masse.
   *
   * Introduced Phase 7.B (2026-04-18). See
   * `packages/adapters/base/src/contract/scenarios/path-scope-dispatch.ts`
   * and `.../shell-ast-gate.ts` for the consumer sites.
   */
  readonly scriptProbe?: (probe: ScriptProbeId) => boolean;
}

/**
 * Probe ids recognized by `AdapterUnderTest.scriptProbe`. Current set:
 *
 * - `"path-scope"` — `PATH_SCOPE_ESCAPE_TURN` is sent; the fake driver must
 *   script a Write/Edit tool-call whose target escapes the worktree.
 * - `"shell-gate"` — `SHELL_SUBSTITUTION_TURN` is sent; the fake driver must
 *   script a Bash tool-call with `$()` command substitution.
 *
 * Expansion rule: new probes are introduced as additive union members.
 * Adapters that already declare `scriptProbe` continue to opt into only the
 * probes they advertise.
 */
export type ScriptProbeId = "path-scope" | "shell-gate";

export interface ContractSuiteOptions {
  /** Per-scenario timeout in ms. Default 30000. */
  readonly timeoutMs?: number;
  /** Override the shared logger (the harness defaults to a stderr logger). */
  readonly log?: ContractLogger;
}

/**
 * A single scenario. `id` is the stable test name; `requires` enumerates
 * the `CapabilityFeature`s that must be present for it to run.
 */
export interface Scenario {
  readonly id: string;
  readonly description: string;
  /** List of features the scenario depends on. Empty array = always runs. */
  readonly requires: readonly string[];
  /**
   * The body. Receives a `ScenarioContext` and an already-factoried
   * `AgentHandle`. Throws / rejects to fail.
   */
  run(ctx: ScenarioContext, handle: import("../adapter.ts").AgentHandle): Promise<void>;
}
