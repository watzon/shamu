/**
 * Shared adapter contract suite.
 *
 * Downstream vendor-adapter packages call `runAdapterContractSuite({ ... })`
 * from within a Vitest test file. The function returns nothing — it
 * registers a `describe(...)` block with one `it(...)` per scenario.
 *
 * Scenarios that require capabilities the adapter has declared off are
 * SKIPPED with a loud log entry so a reviewer notices when an adapter
 * declares itself less capable over time. (Skipping silently would let a
 * capability regression slip through CI.)
 */

import { newRunId } from "@shamu/shared/ids";
import { describe, it } from "vitest";
import { type CapabilityFeature, supportsCapability } from "../capabilities.ts";
import { HELLO_TURN } from "./fixtures.ts";
import { capabilityImmutabilityScenario } from "./scenarios/capability-immutability.ts";
import { errorSurfacesScenario } from "./scenarios/error-surfaces.ts";
import { interruptScenario } from "./scenarios/interrupt.ts";
import { multiTurnScenario } from "./scenarios/multi-turn.ts";
import { patchMetadataScenario } from "./scenarios/patch-metadata.ts";
import { pathScopeDispatchScenario } from "./scenarios/path-scope-dispatch.ts";
import { resumeWarmScenario } from "./scenarios/resume-warm.ts";
import { runIdOwnershipScenario } from "./scenarios/run-id-ownership.ts";
import { secretRedactionScenario } from "./scenarios/secret-redaction.ts";
import { setModelScenario } from "./scenarios/set-model.ts";
import { setPermissionModeScenario } from "./scenarios/set-permission-mode.ts";
import { shellAstGateScenario } from "./scenarios/shell-ast-gate.ts";
import { shutdownScenario } from "./scenarios/shutdown.ts";
import { spawnBasicScenario } from "./scenarios/spawn-basic.ts";
import { stressNoLeaksScenario } from "./scenarios/stress-no-leaks.ts";
import { toolCallVisibilityScenario } from "./scenarios/tool-call-visibility.ts";
import { usageAndCostScenario } from "./scenarios/usage-and-cost.ts";
import type { AdapterUnderTest, ContractLogger, ContractSuiteOptions, Scenario } from "./types.ts";

export * from "./fixtures.ts";
export * from "./types.ts";

/** The full ordered list of scenarios. Add new rows here. */
export const CONTRACT_SCENARIOS: readonly Scenario[] = Object.freeze([
  capabilityImmutabilityScenario,
  runIdOwnershipScenario,
  spawnBasicScenario,
  resumeWarmScenario,
  multiTurnScenario,
  interruptScenario,
  setModelScenario,
  setPermissionModeScenario,
  shutdownScenario,
  toolCallVisibilityScenario,
  patchMetadataScenario,
  usageAndCostScenario,
  errorSurfacesScenario,
  stressNoLeaksScenario,
  secretRedactionScenario,
  pathScopeDispatchScenario,
  shellAstGateScenario,
]);

const DEFAULT_TIMEOUT_MS = 30_000;

/** Default logger — writes to stderr via `console.warn/error`. */
const defaultLog: ContractLogger = {
  info: (msg, extra) => {
    if (extra) console.warn(`[contract] ${msg} ${JSON.stringify(extra)}`);
    else console.warn(`[contract] ${msg}`);
  },
  warn: (msg, extra) => {
    if (extra) console.warn(`[contract:WARN] ${msg} ${JSON.stringify(extra)}`);
    else console.warn(`[contract:WARN] ${msg}`);
  },
  error: (msg, extra) => {
    if (extra) console.error(`[contract:ERR] ${msg} ${JSON.stringify(extra)}`);
    else console.error(`[contract:ERR] ${msg}`);
  },
};

/**
 * Kick off the contract suite. MUST be called from within a Vitest file —
 * it's a `describe/it` block builder, not a runner. The returned void is
 * just to make the call site read "runAdapterContractSuite(adapter)".
 */
export function runAdapterContractSuite(
  aut: AdapterUnderTest,
  options: ContractSuiteOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = options.log ?? defaultLog;
  const skipped = new Set(aut.skip ?? []);

  describe(`adapter contract: ${aut.vendor}`, () => {
    for (const scenario of CONTRACT_SCENARIOS) {
      const decision = decideScenario(scenario, aut, skipped);
      if (decision.kind === "skip") {
        // eslint-disable-next-line no-console — intentional loud log so that
        // reviewers see an adapter opting out.
        log.warn(`skipping scenario ${scenario.id} for ${aut.vendor}: ${decision.reason}`);
        it.skip(`${scenario.id} — ${scenario.description} [SKIPPED: ${decision.reason}]`, () => {});
        continue;
      }
      it(
        `${scenario.id} — ${scenario.description}`,
        async () => {
          const cwd = await aut.worktreeFor(scenario.id);
          // `runId` is orchestrator-owned from Phase 2 onward; the harness
          // mints one per scenario to stand in for a real supervisor. The
          // adapter's returned handle.runId MUST match this value.
          const spawnOpts = { cwd, runId: newRunId() };
          const ctx = {
            name: scenario.id,
            adapter: aut.adapter,
            spawnOpts,
            helloTurn: HELLO_TURN,
            timeoutMs,
            log,
          };
          const handle = await aut.factory(ctx);
          try {
            await scenario.run(ctx, handle);
          } finally {
            try {
              await aut.teardown(handle);
            } catch (cause) {
              log.error(`teardown for ${scenario.id} threw`, {
                err: (cause as Error)?.message ?? String(cause),
              });
            }
          }
        },
        timeoutMs + 5_000,
      );
    }
  });
}

type Decision = { kind: "run" } | { kind: "skip"; reason: string };

function decideScenario(
  scenario: Scenario,
  aut: AdapterUnderTest,
  skipped: ReadonlySet<string>,
): Decision {
  if (skipped.has(scenario.id)) {
    return { kind: "skip", reason: "opted out via AdapterUnderTest.skip" };
  }
  for (const feature of scenario.requires) {
    if (!supportsCapability(aut.capabilities, feature as CapabilityFeature)) {
      return {
        kind: "skip",
        reason: `capability ${feature} declared unsupported`,
      };
    }
  }
  return { kind: "run" };
}
