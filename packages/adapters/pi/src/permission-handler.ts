/**
 * Pre-dispatch permission handler for Pi tool calls.
 *
 * Pi surfaces tool activity via the `tool_execution_start` /
 * `tool_execution_update` / `tool_execution_end` async-event stream (per
 * `pi --mode rpc` docs). Each event carries a `toolCallId`, a `toolName`,
 * and the tool's `args` object.
 *
 * The adapter's handle runs each `tool_execution_start` event through this
 * gate BEFORE surfacing it as a `tool_call` `AgentEvent`, so a denied call
 * never reaches downstream flows. On deny the handle:
 *
 *  - emits a projected `tool_call` so the consumer sees what was attempted,
 *  - emits an `error` `AgentEvent` carrying the typed reason,
 *  - force-ends the turn (Pi does not currently expose a per-tool veto
 *    RPC command; stopping the turn is the best available knob).
 *
 * ### Tool-name conventions
 *
 * Pi uses common tool names that overlap the Claude / Codex / OpenCode
 * conventions (`bash`, `read`, `write`, `edit`, …). We match
 * CASE-INSENSITIVELY to hedge against future Pi tool-name normalization.
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

/** Tools whose input we treat as a shell command. Case-insensitive. */
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "run", "exec", "sh", "terminal"]);

/** Tools whose input is expected to carry a path-bearing field. */
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
 * The subset of a Pi `tool_execution_start` event we care about. Declared
 * structurally so tests can pass a fixture without importing any Pi types.
 */
export interface ToolDispatchInput {
  /** Pi's `toolName` field (camelCase on the wire). */
  readonly tool: string;
  readonly input?: Readonly<Record<string, unknown>>;
}

/**
 * Decide whether the pending tool call is permitted. Returns `null` for
 * tools we don't gate (search, reasoning, …) so the caller can fall
 * through to allow.
 */
export function decidePiPermission(
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

/**
 * Collect every string-valued path argument we understand. We do NOT walk
 * arbitrary object graphs — that would admit DoS via deeply-nested input.
 * The set below is intentionally explicit; extend when new Pi tool shapes
 * land.
 */
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
