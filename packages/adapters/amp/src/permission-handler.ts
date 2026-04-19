/**
 * Pre-surfacing permission handler for Amp tool-use events.
 *
 * Amp's own permission model is hosted — the Sourcegraph-hosted agent has
 * already decided to dispatch the tool by the time its `{type:"assistant"}`
 * message with a `tool_use` content block lands on our stdout stream. Our
 * gate therefore runs in ADVISORY mode: we decide before surfacing the
 * tool_call to downstream consumers (flow runner, CLI, dashboard). A denial
 * emits an `error` event AND attempts to cancel the current turn by closing
 * amp's stdin (no in-stream cancel message is documented on amp's JSONL
 * surface as of 2026-04-18 — see followups).
 *
 * Belt-and-suspenders per PLAN §"path-scope at tool-dispatch time" +
 * §"Shell-AST gate": even though amp dispatched, shamu MUST NOT surface
 * the tool_call to a downstream flow that might act on the tool's result.
 *
 * ### Tool-name conventions
 *
 * The exact tool-name dictionary Amp emits is not fully documented in
 * `ampcode.com/news/streaming-json` (research gap, logged as followup).
 * We match case-insensitively against the same vocabulary Claude / Codex /
 * OpenCode use (`write`, `edit`, `bash`, etc.) — extend as new vendor tool
 * names surface in the live test logs.
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
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "run", "exec", "sh", "terminal"]);

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
  "create_file",
  "edit_file",
]);

/**
 * The subset of a `tool_use` block we care about. Declared structurally so
 * tests can pass a fixture without any vendor imports.
 */
export interface ToolDispatchInput {
  readonly tool: string;
  readonly input?: Record<string, unknown>;
}

/**
 * Decide whether the incoming tool call should be surfaced to downstream
 * consumers. Returns `null` for tools we don't gate (web search, etc.) so
 * the caller knows to fall through.
 */
export function decideAmpPermission(
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
 * Collect every string-valued path argument we understand. Explicit key
 * set avoids DoS via deeply-nested input.
 */
function gatherPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const singleKeys = ["file_path", "path", "filename", "target", "destination"];
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
