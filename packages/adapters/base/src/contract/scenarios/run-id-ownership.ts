/**
 * Scenario: the handle's runId equals the orchestrator-supplied opts.runId.
 *
 * Per PLAN.md § 1 + threat-model G8: "runId is orchestrator-owned" from
 * Phase 2 onward. Supervised adapters accept it via SpawnOpts; they must
 * NOT mint their own. Every event yielded MUST also carry this runId — a
 * compromised adapter fabricating a different runId would confuse the
 * supervisor about which run the stream belongs to.
 *
 * Runs unconditionally — no capability gates it.
 */

import type { Scenario } from "../types.ts";
import { collectUntilTurnEnd } from "./spawn-basic.ts";

export const runIdOwnershipScenario: Scenario = {
  id: "run-id-ownership",
  description:
    "handle.runId equals opts.runId; every event's runId matches (G8 — runId is orchestrator-owned)",
  requires: [],
  async run(ctx, handle): Promise<void> {
    if (handle.runId !== ctx.spawnOpts.runId) {
      throw new Error(
        `run-id-ownership: handle.runId=${handle.runId} does not match opts.runId=${ctx.spawnOpts.runId} (G8 — adapter minted its own id)`,
      );
    }

    await handle.send(ctx.helloTurn);
    const events = await collectUntilTurnEnd(handle, ctx.timeoutMs);

    for (const ev of events) {
      if (ev.runId !== ctx.spawnOpts.runId) {
        throw new Error(
          `run-id-ownership: event ${ev.kind} carried runId=${ev.runId} instead of opts.runId=${ctx.spawnOpts.runId}`,
        );
      }
    }
  },
};
