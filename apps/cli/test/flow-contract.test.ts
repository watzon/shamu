/**
 * Tests for `flow-contract.ts` — specifically the `loadFlowModule`
 * resolution path, including the Phase 6.D fallback for user-supplied
 * flow modules that live OUTSIDE the workspace tree and therefore can't
 * resolve `@shamu/*` bare specifiers against their own directory.
 *
 * We exercise the fallback by writing a small flow module into a temp
 * directory (clearly outside `apps/cli/` / any workspace package) and
 * loading it. With the fallback, the module shims into the CLI's own
 * scope so its `@shamu/*` imports resolve.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFlowModule } from "../src/commands/flow-contract.ts";

/**
 * A self-contained flow module source that imports from `@shamu/*`.
 * Intentionally minimal: two nodes + a no-op runner so the schema
 * validation passes.
 */
const OUTSIDE_FLOW_SOURCE = `
import type { RunnerRegistry } from "@shamu/core-flow/runners";
import type { FlowDefinition } from "@shamu/core-flow/types";
import { nodeId } from "@shamu/core-flow/types";

export const name = "outside-flow";

export const flowDefinition: FlowDefinition = {
  id: "outside-flow",
  version: 1,
  entry: nodeId("a"),
  nodes: [
    { kind: "agent_step", id: nodeId("a"), role: "planner", runner: "noop", inputs: {}, dependsOn: [] },
  ],
};

export function registerRunners(registry: RunnerRegistry): void {
  registry.register("noop", async () => ({
    ok: true,
    value: null,
    costUsd: null,
    costConfidence: "unknown",
    costSource: "outside-test",
  }));
}
`.trim();

describe("loadFlowModule — direct path", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "shamu-flow-contract-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("loads a flow module whose path lives outside any workspace via the shim fallback", async () => {
    // Write the flow module deep in /tmp — nowhere near the CLI's
    // workspace. Under the old code this would fail with
    // ERR_MODULE_NOT_FOUND on `@shamu/core-flow`; under the fix the shim
    // fallback shims the file into `apps/cli/.shamu-flow-shim/` so the
    // bare specifiers resolve.
    const flowDir = join(tmpRoot, "nested", "flows");
    mkdirSync(flowDir, { recursive: true });
    const flowPath = join(flowDir, "outside-flow.ts");
    writeFileSync(flowPath, OUTSIDE_FLOW_SOURCE);

    const mod = await loadFlowModule(flowPath);
    expect(mod.name).toBe("outside-flow");
    expect(mod.flowDefinition.id).toBe("outside-flow");
    expect(mod.flowDefinition.nodes).toHaveLength(1);
    expect(typeof mod.registerRunners).toBe("function");
  });

  it("propagates genuine package-not-installed errors (bare spec, not a file path)", async () => {
    // A bare spec that nobody has installed must NOT trigger the shim
    // fallback — we want the underlying import error so the user sees
    // the real problem.
    await expect(loadFlowModule("@shamu/definitely-not-a-package")).rejects.toThrow();
  });
});
