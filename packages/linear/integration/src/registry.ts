/**
 * In-memory bidirectional map from `RunId` ⟷ `issueId`.
 *
 * The pickup driver binds a fresh `runId` to the Linear issue that triggered
 * the pickup, and downstream primitives (the rolling comment, the
 * escalation sink, the PR attacher) look the binding up when they need to
 * reach back from a run-scoped event to the Linear issue it belongs to.
 *
 * Contract:
 *
 *   - `bind(runId, issueId)` — register a new binding. Re-binding the same
 *     `(runId, issueId)` pair is a silent no-op (webhook re-delivery, double
 *     pickup of the same label, etc.). Binding the same `runId` to a
 *     DIFFERENT `issueId` throws `TypeError` — that's programmer error and
 *     signals a mint/bind desync.
 *   - `runIdFor` / `issueIdFor` — bidirectional lookup; return `null` on
 *     miss.
 *   - `release(runId)` — drop a binding. Idempotent.
 *   - `clear()` — drop all bindings; called on shutdown to break refs.
 *   - `size()` — number of active bindings; primarily for tests and
 *     diagnostics.
 *
 * Persistence is out of scope for Phase 6. A long-lived daemon (Phase 8)
 * will need a `run_issue_bindings` SQLite table so restarts don't orphan
 * in-flight runs; this is tracked as a followup in the hand-off.
 */

import type { RunId } from "@shamu/shared/ids";

export interface RunIssueRegistry {
  bind(runId: RunId, issueId: string): void;
  runIdFor(issueId: string): RunId | null;
  issueIdFor(runId: RunId): string | null;
  release(runId: RunId): void;
  clear(): void;
  size(): number;
}

export function createRunIssueRegistry(): RunIssueRegistry {
  const byRun = new Map<RunId, string>();
  const byIssue = new Map<string, RunId>();

  return {
    bind(runId: RunId, issueId: string): void {
      // A double-bind with matching coordinates is safe — e.g. the webhook
      // re-delivered the same label-added event before we acked.
      const existing = byRun.get(runId);
      if (existing !== undefined) {
        if (existing === issueId) return;
        throw new TypeError(
          `RunIssueRegistry: runId already bound to a different issue (runId=${runId}, existing=${existing}, new=${issueId})`,
        );
      }
      byRun.set(runId, issueId);
      byIssue.set(issueId, runId);
    },
    runIdFor(issueId: string): RunId | null {
      return byIssue.get(issueId) ?? null;
    },
    issueIdFor(runId: RunId): string | null {
      return byRun.get(runId) ?? null;
    },
    release(runId: RunId): void {
      const issueId = byRun.get(runId);
      if (issueId === undefined) return;
      byRun.delete(runId);
      byIssue.delete(issueId);
    },
    clear(): void {
      byRun.clear();
      byIssue.clear();
    },
    size(): number {
      return byRun.size;
    },
  };
}
