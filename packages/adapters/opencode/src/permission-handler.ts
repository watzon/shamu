/**
 * Pre-dispatch permission handler for OpenCode tool calls.
 *
 * OpenCode surfaces tool activity as `ToolPart` entries inside
 * `message.part.updated` SSE events. A `ToolStatePending` / `ToolStateRunning`
 * part carries `tool` (name) and `input` (the arguments). The adapter runs
 * each pending tool call through this gate BEFORE letting the server
 * dispatch the tool:
 *
 * - `write`/`edit`/`patch`-style tools: every path-bearing argument must
 *   resolve under the run's worktree (`validatePathInWorktree`).
 * - `bash` / shell-exec tools: the command string must parse cleanly and
 *   contain no `$()` / backticks / pipe-to-shell (`validateShellCommand`).
 *
 * On denial we emit an `error` event AND call `session.abort(sessionId)` via
 * the handle so the server stops the in-flight prompt.
 *
 * This is the same pattern Codex uses — see
 * `packages/adapters/codex/src/permission-handler.ts`. Keeping the shape
 * parallel pays off when we eventually factor a shared base.
 *
 * ### Tool-name conventions
 *
 * OpenCode's built-in tools (as of `@opencode-ai/sdk@1.4.14`) follow the
 * same vocabulary as Claude (`write`, `edit`, `read`, `bash`, `grep`,
 * `glob`, `list`), but server-side names are lowercase with underscores.
 * We match CASE-INSENSITIVELY to avoid flap when the server normalizes
 * casing differently in a future release.
 */

import {
  type PathScopeError,
  type ShellGateError,
  type ShellGatePolicy,
  validatePathInWorktree,
  validateShellCommand,
} from "@shamu/adapters-base";

export type PermissionDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly error: PathScopeError | ShellGateError };

export interface PermissionHandlerOptions {
  /** Absolute path to the run's git worktree. */
  readonly worktreeRoot: string;
  /**
   * Shell gate policy. Omit for the base package's conservative default
   * (structure-only, rejects `$()` / backticks / pipe-to-shell / eval).
   */
  readonly shellPolicy?: ShellGatePolicy;
}

/**
 * Tools whose input we treat as a shell command. Matched case-insensitively.
 * Extend as new vendor tool names surface.
 */
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "run", "exec", "sh"]);

/**
 * Tools whose input is expected to carry a path field (`file_path`, `path`,
 * `filename`). We gate each of them.
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
]);

/**
 * The subset of a `ToolPart` we care about. Declared structurally so tests
 * can pass a fixture without importing the SDK types.
 */
export interface ToolDispatchInput {
  readonly tool: string;
  readonly input?: Record<string, unknown>;
}

/**
 * Decide whether the pending tool call is permitted. Returns `null` for
 * tools we don't gate (web search, reasoning, etc.) so the caller knows to
 * fall through.
 */
export function decideOpencodePermission(
  tool: ToolDispatchInput,
  options: PermissionHandlerOptions,
): PermissionDecision | null {
  const name = (tool.tool ?? "").toLowerCase();
  if (!name) return null;

  if (SHELL_TOOL_NAMES.has(name)) {
    const input = tool.input ?? {};
    const command = pickString(input, ["command", "cmd", "script"]) ?? "";
    const result = validateShellCommand(command, options.shellPolicy);
    if (!result.ok) return { kind: "denied", error: result.error };
    return { kind: "allowed" };
  }

  if (PATH_TOOL_NAMES.has(name)) {
    const input = tool.input ?? {};
    const paths = gatherPaths(input);
    if (paths.length === 0) return { kind: "allowed" };
    for (const p of paths) {
      const r = validatePathInWorktree(options.worktreeRoot, p);
      if (!r.ok) return { kind: "denied", error: r.error };
    }
    return { kind: "allowed" };
  }

  return null;
}

function pickString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Collect every string-valued path argument we understand. We do NOT walk
 * arbitrary object graphs — that would admit DoS via deeply-nested input.
 * The set below is intentionally explicit; extend when new tool shapes land.
 */
function gatherPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const singleKeys = ["file_path", "path", "filename", "target", "destination"];
  for (const k of singleKeys) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) paths.push(v);
  }
  // Some patch-style tools take `files` or `paths` array-of-strings.
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
