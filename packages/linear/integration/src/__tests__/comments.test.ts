/**
 * Unit tests for `createRollingComment`.
 *
 * The fake client records the full sequence of (op, body) so tests can
 * assert that the body grows monotonically and that `finalize` is
 * idempotent. Times are deterministic via an injected `now` counter.
 */

import type {
  CommentRef,
  LinearClient,
  LinearError as RealLinearError,
} from "@shamu/linear-client";
import { LinearError } from "@shamu/linear-client";
import { runId as brandRunId } from "@shamu/shared/ids";
import { err, ok, type Result } from "@shamu/shared/result";
import { describe, expect, it } from "vitest";
import { createRollingComment } from "../comments.ts";

interface FakeCommentCall {
  readonly op: "create" | "update";
  readonly arg1: string; // issueId for create, commentId for update
  readonly body: string;
}

interface FakeInit {
  readonly create?: Array<Result<CommentRef, RealLinearError>>;
  readonly update?: Array<Result<CommentRef, RealLinearError>>;
}

function makeFakeClient(init: FakeInit = {}): {
  client: LinearClient;
  calls: FakeCommentCall[];
} {
  const calls: FakeCommentCall[] = [];
  const createQueue = init.create ?? [];
  const updateQueue = init.update ?? [];

  const client = {
    async createComment(
      issueId: string,
      body: string,
    ): Promise<Result<CommentRef, RealLinearError>> {
      calls.push({ op: "create", arg1: issueId, body });
      const next = createQueue.shift();
      if (next) return next;
      return ok({ id: "comment-default" });
    },
    async updateComment(
      commentId: string,
      body: string,
    ): Promise<Result<CommentRef, RealLinearError>> {
      calls.push({ op: "update", arg1: commentId, body });
      const next = updateQueue.shift();
      if (next) return next;
      return ok({ id: commentId });
    },
  } as unknown as LinearClient;

  return { client, calls };
}

/** Deterministic counter clock. Starts at 1_700_000_000_000 and increments by 1s per call. */
function counterNow(start = 1_700_000_000_000, stepMs = 1_000): () => number {
  let t = start;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}

const RUN_ID = brandRunId("01HZZZTESTRUN0000000000000");

describe("createRollingComment", () => {
  it("begin() produces a deterministic header with runId + ISO timestamp", async () => {
    const { client, calls } = makeFakeClient({
      create: [ok({ id: "comment-1" })],
    });
    const rc = createRollingComment({ client, now: counterNow() });
    const r = await rc.begin({ issueId: "issue-1", runId: RUN_ID, headline: "Test run" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.commentId).toBe("comment-1");
    expect(r.value.issueId).toBe("issue-1");
    expect(r.value.runId).toBe(RUN_ID);
    // Header format.
    const first = calls[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(first.op).toBe("create");
    expect(first.body).toMatch(
      /^## Test run\n\n_runId: 01HZZZTESTRUN0000000000000 started at 2023-11-14T/,
    );
  });

  it("appendCheckpoint renders a new section without truncating prior body", async () => {
    const { client, calls } = makeFakeClient({
      create: [ok({ id: "comment-1" })],
    });
    const rc = createRollingComment({ client, now: counterNow() });
    const r = await rc.begin({ issueId: "issue-1", runId: RUN_ID, headline: "H" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const handle = r.value;
    const ap1 = await handle.appendCheckpoint({ at: 1_700_000_100_000, headline: "step 1" });
    expect(ap1.ok).toBe(true);
    const ap2 = await handle.appendCheckpoint({
      at: 1_700_000_200_000,
      headline: "step 2",
      detail: "two lines\nhere",
    });
    expect(ap2.ok).toBe(true);

    // The second update body must include BOTH the first section and the header.
    const second = calls[2];
    expect(second).toBeDefined();
    if (!second) return;
    expect(second.op).toBe("update");
    expect(second.body).toContain("## H");
    expect(second.body).toContain("step 1");
    expect(second.body).toContain("step 2");
    expect(second.body).toMatch(/> two lines\n> here/);
  });

  it("preserves monotonic timestamp ordering in the body", async () => {
    const { client, calls } = makeFakeClient({
      create: [ok({ id: "comment-1" })],
    });
    const rc = createRollingComment({ client, now: counterNow() });
    const r = await rc.begin({ issueId: "issue-1", runId: RUN_ID, headline: "H" });
    if (!r.ok) throw r.error;
    const handle = r.value;
    await handle.appendCheckpoint({ at: 1_700_000_100_000, headline: "A" });
    await handle.appendCheckpoint({ at: 1_700_000_200_000, headline: "B" });
    await handle.appendCheckpoint({ at: 1_700_000_300_000, headline: "C" });
    const last = calls[calls.length - 1];
    expect(last).toBeDefined();
    if (!last) return;
    const idxA = last.body.indexOf("— A");
    const idxB = last.body.indexOf("— B");
    const idxC = last.body.indexOf("— C");
    expect(idxA).toBeGreaterThan(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
  });

  it("finalize appends a summary section", async () => {
    const { client, calls } = makeFakeClient({
      create: [ok({ id: "comment-1" })],
    });
    const rc = createRollingComment({ client, now: counterNow() });
    const r = await rc.begin({ issueId: "issue-1", runId: RUN_ID, headline: "H" });
    if (!r.ok) throw r.error;
    const fin = await r.value.finalize("all green");
    expect(fin.ok).toBe(true);
    const last = calls[calls.length - 1];
    expect(last).toBeDefined();
    if (!last) return;
    expect(last.body).toContain("---\n## Summary\nall green");
  });

  it("second finalize call is a no-op", async () => {
    const { client, calls } = makeFakeClient({
      create: [ok({ id: "comment-1" })],
    });
    const rc = createRollingComment({ client, now: counterNow() });
    const r = await rc.begin({ issueId: "issue-1", runId: RUN_ID, headline: "H" });
    if (!r.ok) throw r.error;
    const handle = r.value;
    const fin1 = await handle.finalize("done");
    expect(fin1.ok).toBe(true);
    const callsAfterFirst = calls.length;
    const fin2 = await handle.finalize("done again");
    expect(fin2.ok).toBe(true);
    // No additional updateComment call after the second finalize.
    expect(calls.length).toBe(callsAfterFirst);
  });

  it("propagates createComment errors on begin", async () => {
    const boom = new LinearError("rate_limited", "slow down");
    const { client } = makeFakeClient({ create: [err(boom)] });
    const rc = createRollingComment({ client, now: counterNow() });
    const r = await rc.begin({ issueId: "issue-1", runId: RUN_ID, headline: "H" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(boom);
  });

  it("propagates updateComment errors on appendCheckpoint without advancing the body", async () => {
    const boom = new LinearError("http", "500");
    const { client, calls } = makeFakeClient({
      create: [ok({ id: "comment-1" })],
      update: [err(boom), ok({ id: "comment-1" })],
    });
    const rc = createRollingComment({ client, now: counterNow() });
    const r = await rc.begin({ issueId: "issue-1", runId: RUN_ID, headline: "H" });
    if (!r.ok) throw r.error;
    const failed = await r.value.appendCheckpoint({ at: 1_700_000_100_000, headline: "step 1" });
    expect(failed.ok).toBe(false);
    // The next append should NOT repeat "step 1" (it was never committed)
    // because the in-memory body didn't advance past the failed update.
    const retried = await r.value.appendCheckpoint({
      at: 1_700_000_200_000,
      headline: "step 1-retry",
    });
    expect(retried.ok).toBe(true);
    const lastUpdate = calls.filter((c) => c.op === "update").pop();
    expect(lastUpdate).toBeDefined();
    if (!lastUpdate) return;
    // The body contains step 1-retry but NOT the ephemeral step 1 (which was rolled back).
    expect(lastUpdate.body).toContain("step 1-retry");
    expect(lastUpdate.body).not.toContain("— step 1\n");
  });
});
