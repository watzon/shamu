/**
 * Phase 6.D smoke flow — a 3-node pass-through flow used by the live
 * Linear E2E test.
 *
 * Avoids burning Claude/Codex credits while exercising 100% of the
 * Linear orchestration surface:
 *
 *   1. `plan` emits a trivial plan value.
 *   2. `execute` emits a fake patch reference (the rolling comment
 *      bridge will turn this into a checkpoint append).
 *   3. `review` emits a final approve verdict.
 *
 * Each node sleeps briefly so the rolling-comment appends land in Linear
 * with visible intervals.  Total runtime ≈ 3 seconds.
 *
 * Not part of any production surface — intentionally outside of
 * `packages/flows/*` so it never ships in a release binary.  Invoked by
 * pointing `shamu linear serve --flow-module=./scripts/e2e-smoke-flow.ts`
 * at this file.
 */

import type { RunnerContext, RunnerRegistry } from "@shamu/core-flow/runners";
import type { FlowDefinition, NodeOutput } from "@shamu/core-flow/types";
import { nodeId } from "@shamu/core-flow/types";

import type { RegisterRunnersOptions } from "../src/commands/flow-contract.ts";

export const name = "e2e-smoke-flow";

export const flowDefinition: FlowDefinition = {
  id: "e2e-smoke-flow",
  version: 1,
  entry: nodeId("plan"),
  nodes: [
    {
      kind: "agent_step",
      id: nodeId("plan"),
      role: "planner",
      runner: "smoke-plan",
      inputs: { step: "plan" },
      dependsOn: [],
    },
    {
      kind: "agent_step",
      id: nodeId("execute"),
      role: "executor",
      runner: "smoke-execute",
      inputs: { step: "execute" },
      dependsOn: [nodeId("plan")],
    },
    {
      kind: "agent_step",
      id: nodeId("review"),
      role: "reviewer",
      runner: "smoke-review",
      inputs: { step: "review" },
      dependsOn: [nodeId("execute")],
    },
  ],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerRunners(registry: RunnerRegistry, _opts: RegisterRunnersOptions): void {
  registry.register("smoke-plan", async (ctx: RunnerContext): Promise<NodeOutput> => {
    await sleep(800);
    const inputs = ctx.inputs as Record<string, unknown>;
    const initial = (inputs.initial ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      value: { step: "plan", task: initial.task ?? null, steps: ["execute", "review"] },
      costUsd: 0,
      costConfidence: "exact",
      costSource: "e2e-smoke",
    };
  });

  registry.register("smoke-execute", async (_ctx: RunnerContext): Promise<NodeOutput> => {
    await sleep(1000);
    return {
      ok: true,
      value: { step: "execute", patch: { files: ["README.md"], adds: 1, dels: 0 } },
      costUsd: 0,
      costConfidence: "exact",
      costSource: "e2e-smoke",
    };
  });

  registry.register("smoke-review", async (_ctx: RunnerContext): Promise<NodeOutput> => {
    await sleep(600);
    return {
      ok: true,
      value: { step: "review", verdict: "approve", rationale: "smoke flow pass-through" },
      costUsd: 0,
      costConfidence: "exact",
      costSource: "e2e-smoke",
    };
  });
}
