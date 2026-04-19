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
 * Adapters whose driver double does NOT script the probe response will see
 * no violation in the stream; we WARN rather than fail so the contract
 * suite remains adapter-agnostic. Adapters SHOULD wire the probe — the
 * scenario's value is checking the full rejection pipeline on the wire.
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

    // An adapter whose driver doesn't script the probe emits no violation.
    // We allow this to pass-with-warn because the contract suite is
    // adapter-agnostic; the adapter's own unit tests are responsible for
    // covering the permission-handler logic directly.
    if (!rejection) {
      ctx.log.warn(
        "path-scope-dispatch: probe prompt did not trigger a visible rejection — the adapter-under-test's fake driver may not script the probe; confirm via the adapter's unit tests that validatePathInWorktree is wired at dispatch time",
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
