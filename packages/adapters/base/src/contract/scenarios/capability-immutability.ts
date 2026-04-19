/**
 * Scenario: `adapter.capabilities` is a frozen object (G8 — per PLAN.md § 1
 * "Capabilities are declared, not inferred. ... Capability declarations are
 * immutable"). The adapter process MUST NOT be able to upgrade or downgrade
 * its own capabilities at runtime.
 *
 * We enforce this structurally: the declared manifest must come back from
 * `freezeCapabilities()` (so `Object.isFrozen === true`) and mutations through
 * the same reference MUST throw in strict mode / silently no-op in sloppy
 * mode. Vitest runs TypeScript as strict ESM, so a write to a frozen object
 * throws — we just need to catch and assert.
 *
 * Always runs — no capability gates this scenario.
 */

import type { Scenario } from "../types.ts";

export const capabilityImmutabilityScenario: Scenario = {
  id: "capability-immutability",
  description:
    "adapter.capabilities is a frozen immutable object (G8 — adapter cannot self-upgrade capabilities at runtime)",
  requires: [],
  async run(ctx): Promise<void> {
    const caps = ctx.adapter.capabilities;

    if (!caps || typeof caps !== "object") {
      throw new Error(
        `capability-immutability: adapter.capabilities must be an object; got ${typeof caps}`,
      );
    }
    if (!Object.isFrozen(caps)) {
      throw new Error("capability-immutability: adapter.capabilities must be a frozen object (G8)");
    }

    // Attempt a structural mutation. A frozen object rejects this — strict
    // mode throws; sloppy mode silently no-ops. Either way, the write must
    // not take effect; if it does, the adapter has broken the invariant.
    const before = caps.interrupt;
    try {
      (caps as { interrupt: string }).interrupt = "__mutated_by_contract_suite__";
    } catch {
      // Expected under strict mode. Fall through to the post-check below.
    }
    if (caps.interrupt !== before) {
      throw new Error(
        `capability-immutability: mutation to adapter.capabilities.interrupt took effect (${before} -> ${caps.interrupt})`,
      );
    }

    // Attempt to add a new property. Same rules: freeze rejects.
    try {
      (caps as Record<string, unknown>).__contract_suite_extra__ = true;
    } catch {
      // Expected.
    }
    if ("__contract_suite_extra__" in caps) {
      throw new Error(
        "capability-immutability: adding a new property to adapter.capabilities was permitted",
      );
    }
  },
};
