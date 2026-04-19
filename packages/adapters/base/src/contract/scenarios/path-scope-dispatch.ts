/**
 * Scenario: path-scope rejection at tool-dispatch time (G4).
 *
 * PLAN.md § 1 + Security: "Path-scope is enforced at tool-dispatch time, not
 * just pre-commit. The adapter's permission handler validates every
 * filesystem tool-call path against the current worktree root BEFORE the
 * tool runs." This scenario sends a well-known probe prompt
 * (`PATH_SCOPE_ESCAPE_TURN`). The adapter-under-test's fake driver must
 * recognize the probe and script a `Write` / `Edit` (or vendor equivalent)
 * tool call whose target path is an absolute path OUTSIDE `opts.cwd`.
 *
 * Expected observations (any one satisfies the invariant):
 *
 * 1. An `error` event with `errorCode` that names the violation
 *    (`path_scope_violation` for Codex; claude surfaces via
 *    `permission_result`/`deny`).
 * 2. A `permission_request` event with `decision: "deny"` for the offending
 *    tool call.
 * 3. The stream emits no `patch_applied` referencing the offending path.
 *
 * ### Warn-only vs fail-loud (Phase 7.B opt-in)
 *
 * An adapter-under-test can declare `scriptProbe("path-scope") === true` to
 * promise that its fake driver schedules a rule-breaking tool-call in
 * response to the probe. When that promise is made, this scenario fails
 * LOUD if no rejection is observed — a missing G4 gate is a contract
 * violation, not a driver gap. When the adapter doesn't declare the probe
 * (echo / claude / codex / opencode today; Phase 7.G may migrate them), we
 * emit a warning instead so downstream adapters whose drivers aren't wired
 * for the probe can still participate in the contract suite.
 *
 * Requires: `streamingEvents` — adapters that only emit final-only streams
 * can't demonstrate mid-turn rejection.
 */

import { PATH_SCOPE_ESCAPE_TURN } from "../fixtures.ts";
import type { Scenario } from "../types.ts";
import { collectUntilTurnEnd } from "./spawn-basic.ts";

export const pathScopeDispatchScenario: Scenario = {
  id: "path-scope-dispatch",
  description:
    "path-scope violation attempt is rejected at dispatch time (G4) via error/permission_request; no patch_applied leaks",
  requires: ["streamingEvents"],
  async run(ctx, handle): Promise<void> {
    await handle.send(PATH_SCOPE_ESCAPE_TURN);
    const events = await collectUntilTurnEnd(handle, ctx.timeoutMs);

    // Scan for any rejection signal. The shape differs across adapters:
    // Codex emits `error` with `errorCode` from `PathScopeError.code`;
    // Claude emits a denied `permission_request`; others may choose either.
    const rejection = events.find((e) => {
      if (e.kind === "error") {
        const code = e.errorCode ?? "";
        return /path[_-]?scope|out.?of.?worktree|absolute.?outside|scope.?violation/i.test(code);
      }
      if (e.kind === "permission_request") {
        return e.decision === "deny";
      }
      return false;
    });

    const probeScripted = ctx.scriptProbeSupported("path-scope");
    if (!rejection) {
      if (probeScripted) {
        throw new Error(
          "path-scope-dispatch: adapter declared scriptProbe('path-scope') === true but the probe prompt produced no visible rejection. Either the fake driver did not emit a rule-breaking tool-call, or the adapter's permission handler did not fire. Both are contract violations (G4).",
        );
      }
      ctx.log.warn(
        "path-scope-dispatch: probe prompt did not trigger a visible rejection — the adapter-under-test did not declare scriptProbe('path-scope'); confirm via the adapter's unit tests that validatePathInWorktree is wired at dispatch time",
      );
      return;
    }

    // If a rejection appeared, assert no `patch_applied` references the
    // outside path — the attacker's write must not land.
    for (const ev of events) {
      if (ev.kind !== "patch_applied") continue;
      for (const file of ev.files) {
        if (/^\/etc\/|^\/tmp\/|^\/var\//.test(file)) {
          throw new Error(
            `path-scope-dispatch: patch_applied carried an out-of-worktree path ${file} even though the adapter signaled rejection`,
          );
        }
      }
    }
  },
};
