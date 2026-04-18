/**
 * Test fixture: a one-node flow that drives the flow runner without
 * requiring adapter subprocesses or the canonical flow's heavy deps.
 *
 * Used by `test/services/flow-runner.test.ts`. The runner records what
 * the engine hands it into a global capture object so tests can assert
 * on inputs and option round-tripping.
 */

import type { RunnerContext, RunnerRegistry } from "@shamu/core-flow/runners";
import type { FlowDefinition, NodeOutput } from "@shamu/core-flow/types";
import { nodeId } from "@shamu/core-flow/types";

import type { RegisterRunnersOptions } from "../../src/commands/flow-contract.ts";

export const name = "micro-flow";

export const flowDefinition: FlowDefinition = {
  id: "micro-flow",
  version: 1,
  entry: nodeId("only"),
  nodes: [
    {
      kind: "agent_step",
      id: nodeId("only"),
      role: "planner",
      runner: "micro-pass",
      inputs: { label: "only" },
      dependsOn: [],
    },
  ],
};

export function registerRunners(registry: RunnerRegistry, opts: RegisterRunnersOptions): void {
  registry.register("micro-pass", async (ctx: RunnerContext): Promise<NodeOutput> => {
    // The fixture inspects its environment so individual tests can force
    // specific outputs without re-writing the module.
    const inputs = ctx.inputs as Record<string, unknown>;
    const initial = (inputs.initial ?? {}) as Record<string, unknown>;
    const task = initial.task ?? null;
    const captureTarget = process.env.SHAMU_MICRO_FLOW_CAPTURE_GLOBAL;
    if (captureTarget) {
      const g = globalThis as unknown as Record<string, unknown>;
      g[captureTarget] = {
        task,
        workspaceCwd: opts.workspaceCwd,
        maxIterations: opts.maxIterations ?? null,
      };
    }
    return {
      ok: true,
      value: { task, label: "only" },
      costUsd: null,
      costConfidence: "unknown",
      costSource: "micro-flow",
    };
  });
}
