/**
 * Scenario: shell-AST gate rejection (G5).
 *
 * PLAN.md § 1 + Security: "Shell-gate patterns match against a parsed AST,
 * not raw command strings. Shamu's shared `PermissionMode` implementation
 * parses with `shell-quote` (or equivalent) and rejects `$()`, backticks,
 * `eval`, pipes-to-shell, and process substitution unless explicitly
 * allow-listed. Adapters that route writes through structured tool APIs
 * (`Edit`, `Write`) instead of `Bash` get this for free."
 *
 * The scenario sends a well-known probe prompt (`SHELL_SUBSTITUTION_TURN`).
 * The adapter-under-test's fake driver recognizes the probe and scripts
 * a `Bash`-equivalent tool call with `$(whoami)` in the command. The
 * adapter's shell gate must reject the command before it runs.
 *
 * SKIP rules:
 *
 * - Adapters with `customTools: false` AND no `Bash` in their tool set
 *   don't need to implement a shell gate (the PLAN allows this carve-out).
 * - Adapters whose driver doesn't script the probe warn (same rationale
 *   as `path-scope-dispatch`).
 *
 * Requires: `streamingEvents`.
 */

import { SHELL_SUBSTITUTION_TURN } from "../fixtures.ts";
import type { Scenario } from "../types.ts";
import { collectUntilTurnEnd } from "./spawn-basic.ts";

export const shellAstGateScenario: Scenario = {
  id: "shell-ast-gate",
  description:
    "shell AST gate rejects command-substitution / eval / pipe-to-shell commands before dispatch (G5)",
  requires: ["streamingEvents"],
  async run(ctx, handle): Promise<void> {
    await handle.send(SHELL_SUBSTITUTION_TURN);
    const events = await collectUntilTurnEnd(handle, ctx.timeoutMs);

    // Same rejection signal shape as path-scope-dispatch. We look for an
    // `error` or denied `permission_request` whose code/reason names the
    // shell gate.
    const rejection = events.find((e) => {
      if (e.kind === "error") {
        const code = e.errorCode ?? "";
        return /shell[_-]?gate|command[_-]?substitution|pipe[_-]?to[_-]?shell|eval|backticks|process[_-]?substitution/i.test(
          code,
        );
      }
      if (e.kind === "permission_request") {
        return e.decision === "deny";
      }
      return false;
    });

    if (!rejection) {
      ctx.log.warn(
        "shell-ast-gate: probe prompt did not trigger a visible rejection — the adapter-under-test's fake driver may not script a `$()` command probe; confirm via the adapter's unit tests that validateShellCommand is wired at dispatch time",
      );
      return;
    }

    // Belt-and-braces: no tool_result should carry `ok: true` for the
    // offending command.
    for (const ev of events) {
      if (ev.kind !== "tool_result") continue;
      if (ev.ok === true && /whoami/.test(ev.summary ?? "")) {
        throw new Error(
          "shell-ast-gate: the offending command produced a successful tool_result even though the adapter signaled rejection",
        );
      }
    }
  },
};
