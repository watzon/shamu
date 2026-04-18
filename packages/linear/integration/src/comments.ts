/**
 * Rolling comment — one Linear comment per run, edited in place on each
 * checkpoint.
 *
 * Why a rolling comment rather than a new comment per checkpoint: Linear's
 * UI renders comment threads chronologically, and a noisy stream of
 * checkpoints swamps every other comment on the issue. The Phase 6 plan
 * specifies ONE comment per run, with each checkpoint appended as a new
 * section inside it, and a terminal `## Summary` section appended on
 * `finalize()`.
 *
 * Contract:
 *
 *   - `begin({ issueId, runId, headline })` creates the comment with a
 *     deterministic header. The returned handle carries the
 *     full-body-in-memory state and exposes `appendCheckpoint` + `finalize`.
 *   - `appendCheckpoint(ck)` concatenates a new `### <iso> — <headline>`
 *     section (plus an optional `> detail` blockquote) to the body and calls
 *     `client.updateComment(commentId, fullBody)`. Linear's commentUpdate
 *     replaces the full body — there's no append mode — so we keep the
 *     running body in memory on the handle.
 *   - `finalize(summary)` appends a `---\n## Summary\n<summary>` section once
 *     and flips an internal `finalized` flag. Subsequent calls no-op.
 *
 * State-loss note: the body state lives on the returned handle in memory.
 * A process restart mid-run loses it. That's accepted for 6.C.2; the Phase
 * 8 daemon grows a persistent comment table (`run_rolling_comments`?) in
 * `@shamu/persistence` so long-lived daemons can reconstruct the body on
 * boot. Tracked as a followup.
 *
 * Determinism: all timestamps are rendered from an injected `now` — the
 * default is `Date.now`, but tests override with a counter. The renderer
 * only uses `new Date(ms).toISOString()` to keep output locale-free.
 */

import type { LinearClient, LinearError } from "@shamu/linear-client";
import type { RunId } from "@shamu/shared/ids";
import { ok, type Result } from "@shamu/shared/result";
import type { Checkpoint } from "./types.ts";

export interface RollingCommentOptions {
  readonly client: LinearClient;
  /** Override wall clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface RollingCommentHandle {
  readonly commentId: string;
  readonly issueId: string;
  readonly runId: RunId;
  appendCheckpoint(ck: Checkpoint): Promise<Result<true, LinearError>>;
  finalize(summary: string): Promise<Result<true, LinearError>>;
}

export interface RollingComment {
  begin(input: {
    readonly issueId: string;
    readonly runId: RunId;
    readonly headline: string;
  }): Promise<Result<RollingCommentHandle, LinearError>>;
}

/** Render a checkpoint as a markdown section. Private helper. */
function renderCheckpoint(ck: Checkpoint): string {
  const when = new Date(ck.at).toISOString();
  const head = `### ${when} — ${ck.headline}\n`;
  if (ck.detail !== undefined && ck.detail.length > 0) {
    // Blockquote each line of the detail so multi-line details stay readable.
    const quoted = ck.detail
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `${head}\n${quoted}\n`;
  }
  return head;
}

/** Render the initial header — called once on `begin`. */
function renderHeader(headline: string, runId: RunId, at: number): string {
  const iso = new Date(at).toISOString();
  return `## ${headline}\n\n_runId: ${runId} started at ${iso}_\n`;
}

export function createRollingComment(opts: RollingCommentOptions): RollingComment {
  const { client } = opts;
  const now = opts.now ?? Date.now;

  return {
    async begin(input): Promise<Result<RollingCommentHandle, LinearError>> {
      const initialBody = renderHeader(input.headline, input.runId, now());
      const created = await client.createComment(input.issueId, initialBody);
      if (!created.ok) return created;

      // The running body is held in a closure variable on the handle so
      // each `appendCheckpoint` call can compute a correct full-body update.
      let body = initialBody;
      let finalized = false;

      const handle: RollingCommentHandle = {
        commentId: created.value.id,
        issueId: input.issueId,
        runId: input.runId,
        async appendCheckpoint(ck): Promise<Result<true, LinearError>> {
          const nextBody = `${body}\n${renderCheckpoint(ck)}`;
          const updated = await client.updateComment(created.value.id, nextBody);
          if (!updated.ok) return updated;
          // Commit to the in-memory body only AFTER the wire update
          // succeeded; otherwise a transient failure would desync the cache
          // from Linear's view.
          body = nextBody;
          return ok(true);
        },
        async finalize(summary): Promise<Result<true, LinearError>> {
          if (finalized) return ok(true);
          const nextBody = `${body}\n---\n## Summary\n${summary}\n`;
          const updated = await client.updateComment(created.value.id, nextBody);
          if (!updated.ok) return updated;
          body = nextBody;
          finalized = true;
          return ok(true);
        },
      };
      return ok(handle);
    },
  };
}
