/**
 * Label-state machine — idempotent transitions between the four canonical
 * `shamu:*` labels.
 *
 * Contract:
 *
 *   1. `transition({ issueId, to })` reads the current issue state via
 *      `client.getIssue` and decides what to add / remove.
 *   2. If the issue already carries `to` as its ONLY shamu label, the call is
 *      a no-op and returns `ok(true)`. That makes re-delivery of the same
 *      webhook (Linear retries unacked POSTs) a safe idempotent hit.
 *   3. Otherwise we ADD the target label first, then REMOVE every other shamu
 *      label the issue still carries. Add-before-remove matters: there's
 *      never a window where the issue has zero shamu labels — a concurrent
 *      webhook observer (or a human) never sees a bare issue that appears to
 *      have lost its state.
 *   4. Non-shamu labels (e.g. `bug`, `priority:high`) are never touched. The
 *      "labels to remove" set is computed as
 *      `currentShamuLabels − {targetLabel}`, NOT `currentLabels − {target}`.
 *   5. Any `LinearError` short-circuits the call. No rollback is attempted —
 *      the next `transition` call will converge from whatever partial state
 *      the issue landed in.
 *
 * The state machine has no side-effects beyond `LinearClient` calls — no
 * logger, no timers, no internal state. That keeps it a pure function of
 * (issueId, targetLabel, issue.labelNames) from the caller's perspective.
 */

import type { LinearClient, LinearError } from "@shamu/linear-client";
import { ok, type Result } from "@shamu/shared/result";
import { SHAMU_LABEL_NAMES, type ShamuLabelName } from "./types.ts";

export interface LabelStateMachineOptions {
  readonly client: LinearClient;
}

export interface LabelStateMachine {
  /**
   * Transition an issue to the target shamu label. Idempotent — the call is a
   * no-op when the issue already carries only `to` among the four shamu
   * labels, and always returns `ok(true)` on success.
   */
  transition(input: {
    readonly issueId: string;
    readonly to: ShamuLabelName;
  }): Promise<Result<true, LinearError>>;
}

export function createLabelStateMachine(opts: LabelStateMachineOptions): LabelStateMachine {
  const { client } = opts;

  return {
    async transition(input): Promise<Result<true, LinearError>> {
      const issueRes = await client.getIssue(input.issueId);
      if (!issueRes.ok) return issueRes;

      const currentNames = issueRes.value.labelNames;
      // Snapshot only the shamu-prefixed labels; non-shamu labels are off-limits.
      const currentShamu = new Set<ShamuLabelName>();
      for (const name of currentNames) {
        if (isShamuLabel(name)) currentShamu.add(name);
      }

      const alreadyCorrect = currentShamu.has(input.to) && currentShamu.size === 1;
      if (alreadyCorrect) {
        // Idempotent no-op — re-delivery of the same pickup, or a transition
        // called twice, resolves without firing any mutations.
        return ok(true);
      }

      // Add first so the issue never passes through a zero-shamu-label
      // intermediate state (observable by concurrent webhook listeners).
      if (!currentShamu.has(input.to)) {
        const addRes = await client.addLabel(input.issueId, input.to);
        if (!addRes.ok) return addRes;
      }

      // Remove every OTHER shamu label. Non-shamu labels are untouched.
      for (const name of currentShamu) {
        if (name === input.to) continue;
        const removeRes = await client.removeLabel(input.issueId, name);
        if (!removeRes.ok) return removeRes;
      }

      return ok(true);
    },
  };

  function isShamuLabel(name: string): name is ShamuLabelName {
    return SHAMU_LABEL_NAMES.has(name as ShamuLabelName);
  }
}
