/**
 * `pruneFlowShims` — delete stale entries from the `.shamu-flow-shim/`
 * scratchpad.
 *
 * Background: `apps/cli/src/commands/flow-contract.ts` falls back to a
 * temp-shim when a user-authored flow module lives outside a workspace
 * package. Each resolve creates a tiny file under
 * `<cliRoot>/.shamu-flow-shim/`. In a long-lived daemon, this directory
 * accumulates indefinitely — HANDOFF (Phase 8.A pre-reqs) flagged it as
 * workspace hygiene work.
 *
 * Contract:
 *
 *   - Delete regular files whose `mtime` is older than `maxAgeMs`.
 *   - Leave subdirectories alone (belt-and-suspenders: the shim layer
 *     never creates subdirs, but a future change might).
 *   - Never throw — callers invoke this on boot and on every Nth pickup;
 *     a filesystem hiccup must not crash the daemon. All errors are
 *     swallowed and summarised in the return value.
 *
 * The function is module-private helpers + a single exported entry
 * point; no background tasks. The daemon invokes it from its own pickup
 * counter (see `linear-runtime.ts`), which is also how we get a unit
 * test for it without pulling timers.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface FlowShimPruneOptions {
  /** Directory to prune. Pass the CLI's `.shamu-flow-shim` path. */
  readonly dir: string;
  /** Max age in ms. Defaults to 24h. */
  readonly maxAgeMs?: number;
  /** Clock override for tests. */
  readonly now?: () => number;
}

export interface FlowShimPruneResult {
  /** Files removed. */
  readonly removed: number;
  /** Files scanned (includes those kept). */
  readonly scanned: number;
  /**
   * Best-effort error tally. The prune swallows each per-file error;
   * callers get the count so a bump can be logged as a warning.
   */
  readonly errors: number;
}

/**
 * Default age: 24h. Anything older than this is assumed to have come
 * from a prior daemon lifetime and is safe to remove.
 */
export const DEFAULT_SHIM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function pruneFlowShims(opts: FlowShimPruneOptions): Promise<FlowShimPruneResult> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_SHIM_MAX_AGE_MS;
  const now = opts.now ?? Date.now;
  const threshold = now() - maxAgeMs;

  let entries: string[];
  try {
    entries = await readdir(opts.dir);
  } catch (cause) {
    const code = (cause as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      return { removed: 0, scanned: 0, errors: 0 };
    }
    return { removed: 0, scanned: 0, errors: 1 };
  }

  let removed = 0;
  let errors = 0;
  for (const name of entries) {
    const full = join(opts.dir, name);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(full);
    } catch {
      errors += 1;
      continue;
    }
    if (!info.isFile()) continue;
    if (info.mtimeMs > threshold) continue;
    try {
      await rm(full, { force: true });
      removed += 1;
    } catch {
      errors += 1;
    }
  }

  return {
    removed,
    scanned: entries.length,
    errors,
  };
}
