/**
 * Unit tests for `createLabelStateMachine`.
 *
 * We hand-roll a minimal `LinearClient` fake that implements only the three
 * methods the state machine calls (`getIssue`, `addLabel`, `removeLabel`) so
 * the test assertions can target the exact call order + arguments. No fetch
 * stubs, no real Linear calls.
 */

import type { Issue, LinearClient, LinearError as RealLinearError } from "@shamu/linear-client";
import { LinearError } from "@shamu/linear-client";
import { err, ok, type Result } from "@shamu/shared/result";
import { describe, expect, it } from "vitest";
import { createLabelStateMachine } from "../labels.ts";
import { SHAMU_LABELS } from "../types.ts";

interface FakeCall {
  readonly op: "getIssue" | "addLabel" | "removeLabel";
  readonly arg1: string;
  readonly arg2?: string;
}

interface FakeClientInit {
  /** Labels the issue currently carries. */
  readonly labelNames: readonly string[];
  /** Per-op result queue; each pop returns the next queued Result. */
  readonly getIssue?: Array<Result<Issue, RealLinearError>>;
  readonly addLabel?: Array<Result<true, RealLinearError>>;
  readonly removeLabel?: Array<Result<true, RealLinearError>>;
}

/** Build the narrow client shape the state machine uses. */
function makeFakeClient(init: FakeClientInit): {
  client: LinearClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const issue: Issue = {
    id: "issue-1",
    identifier: "SHA-1",
    title: "t",
    description: null,
    url: "https://linear.app/shamu/SHA-1",
    teamId: "team-1",
    stateId: "state-1",
    stateName: "Todo",
    labelIds: init.labelNames.map((_, i) => `label-${i}`),
    labelNames: init.labelNames,
  };
  const getIssueQueue: Array<Result<Issue, RealLinearError>> = init.getIssue ?? [ok(issue)];
  const addLabelQueue = init.addLabel ?? [];
  const removeLabelQueue = init.removeLabel ?? [];

  // Cast: the state machine only touches three methods, so a structural
  // fake with just those is enough. TypeScript needs the cast because the
  // full class surface is wider.
  const client = {
    async getIssue(id: string): Promise<Result<Issue, RealLinearError>> {
      calls.push({ op: "getIssue", arg1: id });
      const next = getIssueQueue.shift();
      if (!next) return ok(issue);
      return next;
    },
    async addLabel(issueId: string, labelName: string): Promise<Result<true, RealLinearError>> {
      calls.push({ op: "addLabel", arg1: issueId, arg2: labelName });
      const next = addLabelQueue.shift();
      if (!next) return ok(true);
      return next;
    },
    async removeLabel(issueId: string, labelName: string): Promise<Result<true, RealLinearError>> {
      calls.push({ op: "removeLabel", arg1: issueId, arg2: labelName });
      const next = removeLabelQueue.shift();
      if (!next) return ok(true);
      return next;
    },
  } as unknown as LinearClient;

  return { client, calls };
}

describe("createLabelStateMachine", () => {
  it("no-ops when the issue already carries only the target shamu label", async () => {
    const { client, calls } = makeFakeClient({ labelNames: [SHAMU_LABELS.ready] });
    const sm = createLabelStateMachine({ client });
    const r = await sm.transition({ issueId: "issue-1", to: SHAMU_LABELS.ready });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ op: "getIssue", arg1: "issue-1" }]);
  });

  it("ready → in-progress adds in-progress then removes ready", async () => {
    const { client, calls } = makeFakeClient({ labelNames: [SHAMU_LABELS.ready] });
    const sm = createLabelStateMachine({ client });
    const r = await sm.transition({ issueId: "issue-1", to: SHAMU_LABELS.inProgress });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([
      { op: "getIssue", arg1: "issue-1" },
      { op: "addLabel", arg1: "issue-1", arg2: SHAMU_LABELS.inProgress },
      { op: "removeLabel", arg1: "issue-1", arg2: SHAMU_LABELS.ready },
    ]);
  });

  it("in-progress → review adds review then removes in-progress", async () => {
    const { client, calls } = makeFakeClient({ labelNames: [SHAMU_LABELS.inProgress] });
    const sm = createLabelStateMachine({ client });
    const r = await sm.transition({ issueId: "issue-1", to: SHAMU_LABELS.review });
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.op)).toEqual(["getIssue", "addLabel", "removeLabel"]);
    expect(calls[1]?.arg2).toBe(SHAMU_LABELS.review);
    expect(calls[2]?.arg2).toBe(SHAMU_LABELS.inProgress);
  });

  it("any → blocked works from review", async () => {
    const { client, calls } = makeFakeClient({ labelNames: [SHAMU_LABELS.review] });
    const sm = createLabelStateMachine({ client });
    const r = await sm.transition({ issueId: "issue-1", to: SHAMU_LABELS.blocked });
    expect(r.ok).toBe(true);
    expect(calls[1]?.arg2).toBe(SHAMU_LABELS.blocked);
    expect(calls[2]?.arg2).toBe(SHAMU_LABELS.review);
  });

  it("preserves non-shamu labels when transitioning", async () => {
    // Issue carries two non-shamu labels plus the current shamu label; the
    // machine must leave the non-shamu pair alone.
    const { client, calls } = makeFakeClient({
      labelNames: ["bug", SHAMU_LABELS.ready, "priority:high"],
    });
    const sm = createLabelStateMachine({ client });
    const r = await sm.transition({ issueId: "issue-1", to: SHAMU_LABELS.inProgress });
    expect(r.ok).toBe(true);
    // addLabel only adds in-progress; removeLabel only removes ready; no other mutations.
    const addRemoves = calls.filter((c) => c.op !== "getIssue");
    expect(addRemoves).toHaveLength(2);
    expect(addRemoves.map((c) => c.arg2)).toEqual([SHAMU_LABELS.inProgress, SHAMU_LABELS.ready]);
  });

  it("handles an issue with multiple shamu labels by removing every non-target shamu label", async () => {
    // Pathological but possible (e.g. human mis-click). After transition,
    // only the target shamu label should remain.
    const { client, calls } = makeFakeClient({
      labelNames: [SHAMU_LABELS.ready, SHAMU_LABELS.inProgress, "bug"],
    });
    const sm = createLabelStateMachine({ client });
    const r = await sm.transition({ issueId: "issue-1", to: SHAMU_LABELS.review });
    expect(r.ok).toBe(true);
    // addLabel review + remove(ready) + remove(in-progress)
    const nonGet = calls.filter((c) => c.op !== "getIssue");
    expect(nonGet).toHaveLength(3);
    expect(nonGet[0]).toMatchObject({ op: "addLabel", arg2: SHAMU_LABELS.review });
    expect(
      nonGet
        .slice(1)
        .map((c) => c.arg2)
        .sort(),
    ).toEqual([SHAMU_LABELS.inProgress, SHAMU_LABELS.ready].sort());
  });

  it("propagates getIssue errors unchanged", async () => {
    const boom = new LinearError("network", "offline");
    const { client, calls } = makeFakeClient({
      labelNames: [SHAMU_LABELS.ready],
      getIssue: [err(boom)],
    });
    const sm = createLabelStateMachine({ client });
    const r = await sm.transition({ issueId: "issue-1", to: SHAMU_LABELS.inProgress });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(boom);
    // No mutations fired.
    expect(calls.filter((c) => c.op !== "getIssue")).toHaveLength(0);
  });

  it("propagates addLabel errors without attempting removal", async () => {
    const boom = new LinearError("forbidden", "no");
    const { client, calls } = makeFakeClient({
      labelNames: [SHAMU_LABELS.ready],
      addLabel: [err(boom)],
    });
    const sm = createLabelStateMachine({ client });
    const r = await sm.transition({ issueId: "issue-1", to: SHAMU_LABELS.inProgress });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(boom);
    // getIssue + addLabel fired; no removeLabel.
    expect(calls.map((c) => c.op)).toEqual(["getIssue", "addLabel"]);
  });

  it("propagates removeLabel errors after a successful add", async () => {
    const boom = new LinearError("rate_limited", "slow down");
    const { client, calls } = makeFakeClient({
      labelNames: [SHAMU_LABELS.ready],
      removeLabel: [err(boom)],
    });
    const sm = createLabelStateMachine({ client });
    const r = await sm.transition({ issueId: "issue-1", to: SHAMU_LABELS.inProgress });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(boom);
    // getIssue + addLabel + removeLabel all fired (the remove failed).
    expect(calls.map((c) => c.op)).toEqual(["getIssue", "addLabel", "removeLabel"]);
  });
});
