/**
 * Pre-dispatch permission handler for Gemini ACP tool calls.
 *
 * ACP's `session/request_permission` delivers a pending tool call before
 * the agent dispatches. The handler decides allow/deny and returns an
 * `AcpPermissionDecision` that the ACP client sends back.
 *
 * Gemini CLI hosts its own tool set (`customTools: false`). The tool-name
 * dictionary is the delta vs Cursor — Gemini exposes `Shell` as the
 * canonical shell-exec tool (capitalized), plus `ReadFile`, `WriteFile`,
 * `Edit`, etc. We match case-insensitively so both the Gemini capitalized
 * names and any lower-case variants (as well as Cursor-compatible names)
 * funnel into the same gate classification. The *gate logic itself* (path
 * scope + shell AST) is identical to Cursor's implementation.
 *
 * On deny: return `{ outcome: "selected", optionId: <reject-optionId> }`.
 * The ACP server stops the turn; we emit a `permission_request` event with
 * `decision: "deny"` at the adapter layer.
 *
 * ### Duplication note
 *
 * The dispatch-time gate shape (path-scope → write/edit tools; shell-AST →
 * bash/shell tools) is the same shape Cursor's `decideCursorPermission`
 * implements. The only vendor-specific delta is the tool-name set. A
 * future consolidation should hoist the classification + gating logic into
 * `@shamu/adapters-base` (e.g., `decideAcpPermission(req, opts, classifier)`)
 * with the per-adapter classifier supplying the tool-name dictionary.
 * Flagged for Phase 7.G shared-helper extraction.
 */

import {
  type PathScopeError,
  type ShellGateError,
  type ShellGatePolicy,
  validatePathInWorktree,
  validateShellCommand,
} from "@shamu/adapters-base";
import type { AcpPermissionDecision, AcpPermissionRequest } from "@shamu/protocol-acp";

export type GeminiPolicyDecision =
  | { readonly kind: "allowed"; readonly decision: AcpPermissionDecision }
  | {
      readonly kind: "denied";
      readonly decision: AcpPermissionDecision;
      readonly error: PathScopeError | ShellGateError;
    }
  | { readonly kind: "unknown"; readonly decision: AcpPermissionDecision };

export interface GeminiPermissionOptions {
  /** Absolute path to the run's git worktree. */
  readonly worktreeRoot: string;
  /** Shell gate policy override; defaults to base package's conservative default. */
  readonly shellPolicy?: ShellGatePolicy;
}

/**
 * Tool names Gemini CLI exposes as shell-exec. Gemini's canonical name is
 * `Shell` (capitalized); we also accept Cursor-compatible lowercase names
 * so a future projector-merge stays backwards-compatible.
 */
const SHELL_TOOL_NAMES = new Set([
  "shell",
  "bash",
  "run",
  "exec",
  "sh",
  "terminal",
  "run_shell_command",
]);

/**
 * Tools whose input carries a path-bearing field. Gemini exposes
 * `ReadFile` / `WriteFile` / `Edit` / `ReplaceInFile`; we match case-
 * insensitively (see `.toLowerCase()` at the dispatch site) alongside the
 * Cursor-style lowercase names.
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
  "replaceinfile",
  "replace_in_file",
]);

/**
 * Decide whether to allow the pending tool call. The ACP client invokes the
 * caller's handler with the raw request; we return the decision frame the
 * handler will send back.
 */
export function decideGeminiPermission(
  req: AcpPermissionRequest,
  options: GeminiPermissionOptions,
): GeminiPolicyDecision {
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

  // Tools we don't classify — fall through to allow (Gemini's built-in
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
