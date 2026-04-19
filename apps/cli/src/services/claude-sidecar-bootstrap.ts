/**
 * Claude sidecar bootstrap — `lastChance` wrapper for `resolveVendorCli`.
 *
 * Phase 9.A collapsed the old `resolveClaudeCliPath` (which had its own
 * precedence chain: `--claude-cli` → `$CLAUDE_CLI_PATH` → sidecar →
 * PATH) into the shared `resolveVendorCli` resolver. The sidecar
 * bootstrap — `ensureClaudeSidecar()` from `@shamu/adapter-claude`, which
 * lazy-downloads a pinned Claude binary on first run — now runs as the
 * Claude descriptor's `lastChance` hook. That way the sidecar bootstrap
 * fires only when every on-disk candidate misses, and the network I/O
 * doesn't burden users who already have `claude` installed globally.
 *
 * See `packages/adapters/base/src/vendor-cli-resolver.ts` for the
 * resolver contract, `packages/adapters/claude/src/sidecar.ts` for the
 * bootstrap itself.
 */

import type { EnsureClaudeSidecarOptions, EnsureClaudeSidecarResult } from "@shamu/adapter-claude";

export type EnsureSidecarFn = (
  opts: EnsureClaudeSidecarOptions,
) => Promise<EnsureClaudeSidecarResult>;

export interface BuildClaudeLastChanceInput {
  /**
   * Injection seam — production passes the real `ensureClaudeSidecar`
   * imported lazily from `@shamu/adapter-claude`. Tests pass a scripted
   * fake.
   */
  readonly ensureSidecar: EnsureSidecarFn;
  /**
   * Optional diag hook for bootstrap failures. When the sidecar download
   * throws, we let the resolver swallow the error and fall through to
   * `VendorCliNotFoundError`, but operators need to see why — this hook
   * is the wire for the CLI's `writeDiag`.
   */
  readonly onSidecarError?: (err: unknown) => void;
}

/**
 * Build the `lastChance` callback for `resolveVendorCli`.
 *
 * Returns a function that the resolver awaits only after every other
 * candidate (explicit flag, env, config, known install paths, PATH) has
 * missed. The function either returns the sidecar's cached/downloaded
 * path, returns `null` (ensure-sidecar returned a path that doesn't
 * exist, unlikely in practice), or throws — the resolver treats throws
 * as "lastChance failed" and records the error into `.attempts`.
 */
export function buildClaudeLastChance(
  input: BuildClaudeLastChanceInput,
): () => Promise<string | null> {
  return async () => {
    try {
      const out = await input.ensureSidecar({});
      return out.path;
    } catch (err) {
      input.onSidecarError?.(err);
      throw err;
    }
  };
}
