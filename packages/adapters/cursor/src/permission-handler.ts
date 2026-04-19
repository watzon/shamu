/**
 * Pre-dispatch permission handler for Cursor ACP tool calls.
 *
 * ACP's `session/request_permission` delivers a pending tool call before
 * the agent dispatches. The handler decides allow/deny and returns an
 * `AcpPermissionDecision` that the ACP client sends back.
 *
 * Cursor's built-in tools (hosted server-side; `customTools: false`) follow
 * the same vocabulary as Claude/OpenCode: `write`, `edit`, `read`, `create`,
 * `bash`, etc. We match case-insensitively and gate:
 *
 * - path-bearing tools (`write`, `edit`, `create`, `delete`, ...):
 *   every path-shaped argument must resolve under the worktree
 *   (`validatePathInWorktree`).
 * - shell-exec tools (`bash`, `shell`, `run`, ...):
 *   the command string must parse cleanly and contain no `$()` / backticks /
 *   pipe-to-shell / eval (`validateShellCommand`).
 *
 * On deny: return `{ outcome: "selected", optionId: <deny-optionId>, reason }`.
 * The ACP server stops the turn; we emit a `permission_request` event with
 * `decision: "deny"` at the adapter layer.
 *
 * ### Option-id selection
 *
 * ACP `session/request_permission` carries an `options[]` array advertised
 * by the server. Cursor's docs show the standard kinds `allow_once`,
 * `allow_always`, `reject_once`, `reject_always`. We select the FIRST option
 * whose `kind` matches the policy decision. If the server only advertised
 * custom option ids, we fall back to the first option and cancel the
 * request via `{ outcome: "cancelled" }` so the agent sees the turn abort.
 */

import {
  type PathScopeError,
  type ShellGateError,
  type ShellGatePolicy,
  validatePathInWorktree,
  validateShellCommand,
} from "@shamu/adapters-base";
import type { AcpPermissionDecision, AcpPermissionRequest } from "@shamu/protocol-acp";

export type CursorPolicyDecision =
  | { readonly kind: "allowed"; readonly decision: AcpPermissionDecision }
  | {
      readonly kind: "denied";
      readonly decision: AcpPermissionDecision;
      readonly error: PathScopeError | ShellGateError;
    }
  | { readonly kind: "unknown"; readonly decision: AcpPermissionDecision };

export interface CursorPermissionOptions {
  /** Absolute path to the run's git worktree. */
  readonly worktreeRoot: string;
  /** Shell gate policy override; defaults to base package's conservative default. */
  readonly shellPolicy?: ShellGatePolicy;
}

/**
 * Tool names whose input we treat as a shell command. Matched
 * case-insensitively. Extend as new Cursor tool names surface.
 */
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "run", "exec", "sh", "terminal"]);

/**
 * Tools whose input is expected to carry a path-bearing field.
 */
const PATH_TOOL_NAMES = new Set([
  "write",
  "edit",
  "read",
  "create",
  "delete",
  "patch",
  "apply_patch",
  "update",
  "rename",
  "write_file",
  "edit_file",
  "read_file",
]);

/**
 * Decide whether to allow the pending tool call. The ACP client invokes the
 * caller's handler with the raw request; we return the decision frame the
 * handler will send back.
 */
export function decideCursorPermission(
  req: AcpPermissionRequest,
  options: CursorPermissionOptions,
): CursorPolicyDecision {
  const tool = req.toolCall;
  const toolName = (tool.name ?? tool.kind ?? "").toLowerCase();
  const input = tool.input ?? tool.rawInput ?? {};

  // Shell gate.
  if (SHELL_TOOL_NAMES.has(toolName)) {
    const command = pickString(input, ["command", "cmd", "script"]) ?? "";
    const result = validateShellCommand(command, options.shellPolicy);
    if (!result.ok) {
      return {
        kind: "denied",
        error: result.error,
        decision: pickDecisionFor("deny", req),
      };
    }
    return { kind: "allowed", decision: pickDecisionFor("allow", req) };
  }

  // Path scope.
  if (PATH_TOOL_NAMES.has(toolName)) {
    const paths = gatherPaths(input);
    if (paths.length === 0) {
      return { kind: "allowed", decision: pickDecisionFor("allow", req) };
    }
    for (const p of paths) {
      const r = validatePathInWorktree(options.worktreeRoot, p);
      if (!r.ok) {
        return {
          kind: "denied",
          error: r.error,
          decision: pickDecisionFor("deny", req),
        };
      }
    }
    return { kind: "allowed", decision: pickDecisionFor("allow", req) };
  }

  // Tools we don't classify — fall through to allow (the server's built-in
  // policy is the backstop). A future expansion may promote unknown-tool
  // denial to a capability flag.
  return { kind: "unknown", decision: pickDecisionFor("allow", req) };
}

/**
 * Choose an `optionId` out of the ACP request's advertised options that
 * matches the policy's allow/deny intent. Matching is by the ACP
 * `option.kind` field; vendor-specific kinds fall back to a first-option
 * `cancelled` decision (the safer default — the agent sees the turn abort).
 */
function pickDecisionFor(
  intent: "allow" | "deny",
  req: AcpPermissionRequest,
): AcpPermissionDecision {
  const order =
    intent === "allow"
      ? (["allow_once", "allow_always"] as const)
      : (["reject_once", "reject_always"] as const);
  for (const kind of order) {
    const match = req.options.find((o) => o.kind === kind);
    if (match) return { outcome: "selected", optionId: match.optionId };
  }
  // Couldn't find a well-known option. Cancelling is the safer default for
  // a deny intent; for an allow intent it's still acceptable — the server
  // will simply abort the tool dispatch.
  return { outcome: "cancelled" };
}

function pickString(
  input: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function gatherPaths(input: Readonly<Record<string, unknown>>): string[] {
  const paths: string[] = [];
  const singleKeys = [
    "file_path",
    "path",
    "filename",
    "target",
    "destination",
    "abs_path",
    "absolutePath",
  ];
  for (const k of singleKeys) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) paths.push(v);
  }
  for (const k of ["files", "paths", "patches"]) {
    const v = input[k];
    if (Array.isArray(v)) {
      for (const entry of v) {
        if (typeof entry === "string" && entry.length > 0) paths.push(entry);
        else if (
          entry !== null &&
          typeof entry === "object" &&
          typeof (entry as { path?: unknown }).path === "string"
        ) {
          paths.push((entry as { path: string }).path);
        }
      }
    }
  }
  return paths;
}
