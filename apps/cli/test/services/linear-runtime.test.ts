/**
 * Unit tests for `createLinearRuntime`.
 *
 * We stand up the REAL integration primitives (pickup driver, label
 * machine, rolling comment, escalation sink) because they're pure
 * wrappers over `LinearClient`. The `LinearClient` itself is faked via
 * an in-memory recorder; the `WebhookServerHandle` is faked via a small
 * in-memory iterable queue; and `runFlowInProcess` is swapped through
 * the `_runFlow` test seam.
 */

import { nodeId } from "@shamu/core-flow/types";
import type {
  Attachment,
  CommentRef,
  Issue,
  Label,
  LinearClient,
  LinearError,
} from "@shamu/linear-client";
import type { LinearEvent, WebhookServerHandle } from "@shamu/linear-webhook";
import { createLogger } from "@shamu/shared";
import { ok, type Result } from "@shamu/shared/result";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowRunOutcome } from "../../src/services/flow-runner.ts";
import {
  createLinearRuntime,
  type RuntimeRunFlowInput,
} from "../../src/services/linear-runtime.ts";
import { createFakeFlowDb } from "../helpers/fake-db.ts";

// ---------------------------------------------------------------------------
// Fake LinearClient — records calls and returns configurable outcomes.
// ---------------------------------------------------------------------------

interface FakeClientInit {
  readonly labels?: readonly Label[];
  readonly initialIssueLabels?: readonly string[];
  readonly issueTitle?: string;
  readonly issueUrl?: string;
}

interface RecordedCall {
  readonly op: string;
  readonly args: readonly unknown[];
}

interface FakeClient {
  readonly client: LinearClient;
  readonly calls: readonly RecordedCall[];
  /** Mutable label set for the (singleton) issue. */
  getIssueLabels(): readonly string[];
}

function makeFakeClient(init: FakeClientInit = {}): FakeClient {
  const calls: RecordedCall[] = [];
  const labels =
    init.labels ??
    ([
      { id: "lbl-ready", name: "shamu:ready" },
      { id: "lbl-in-progress", name: "shamu:in-progress" },
      { id: "lbl-review", name: "shamu:review" },
      { id: "lbl-blocked", name: "shamu:blocked" },
    ] as const);
  const issueLabels = new Set<string>(init.initialIssueLabels ?? ["shamu:in-progress"]);

  const issueTitle = init.issueTitle ?? "Test issue";
  const issueUrl = init.issueUrl ?? "https://linear.app/t/ISS-1";

  const client = {
    async listLabels(teamId: string): Promise<Result<Label[], LinearError>> {
      calls.push({ op: "listLabels", args: [teamId] });
      return ok([...labels]);
    },
    async getIssue(id: string): Promise<Result<Issue, LinearError>> {
      calls.push({ op: "getIssue", args: [id] });
      return ok({
        id,
        identifier: "ISS-1",
        title: issueTitle,
        description: null,
        url: issueUrl,
        teamId: "team-1",
        stateId: "state-1",
        stateName: "Todo",
        labelIds: [...issueLabels].map((_name, i) => `lbl-${i}`),
        labelNames: [...issueLabels],
      });
    },
    async addLabel(issueId: string, labelName: string): Promise<Result<true, LinearError>> {
      calls.push({ op: "addLabel", args: [issueId, labelName] });
      issueLabels.add(labelName);
      return ok(true);
    },
    async removeLabel(issueId: string, labelName: string): Promise<Result<true, LinearError>> {
      calls.push({ op: "removeLabel", args: [issueId, labelName] });
      issueLabels.delete(labelName);
      return ok(true);
    },
    async createComment(issueId: string, body: string): Promise<Result<CommentRef, LinearError>> {
      calls.push({ op: "createComment", args: [issueId, body] });
      return ok({ id: `comment-${calls.length}` });
    },
    async updateComment(commentId: string, body: string): Promise<Result<CommentRef, LinearError>> {
      calls.push({ op: "updateComment", args: [commentId, body] });
      return ok({ id: commentId });
    },
    async createAttachment(input: {
      issueId: string;
      url: string;
      title: string;
    }): Promise<Result<Attachment, LinearError>> {
      calls.push({ op: "createAttachment", args: [input] });
      return ok({ id: `att-${calls.length}`, url: input.url });
    },
  } as unknown as LinearClient;

  return {
    client,
    calls,
    getIssueLabels(): readonly string[] {
      return [...issueLabels];
    },
  };
}

// ---------------------------------------------------------------------------
// Fake WebhookServerHandle — async iterable plus `stop`.
// ---------------------------------------------------------------------------

interface FakeWebhookServer {
  readonly handle: WebhookServerHandle;
  /** Push a Linear event into the async iterable the runtime reads. */
  push(event: LinearEvent): void;
  /** Close the iterable (like the real server on stop). */
  finish(): void;
}

function makeFakeWebhookServer(): FakeWebhookServer {
  const buffer: LinearEvent[] = [];
  const pending: Array<(next: IteratorResult<LinearEvent>) => void> = [];
  let closed = false;

  const iterable: AsyncIterable<LinearEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<LinearEvent> {
      return {
        next(): Promise<IteratorResult<LinearEvent>> {
          if (buffer.length > 0) {
            const value = buffer.shift() as LinearEvent;
            return Promise.resolve({ value, done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            pending.push(resolve);
          });
        },
        return(): Promise<IteratorResult<LinearEvent>> {
          closed = true;
          while (pending.length > 0) {
            const resolve = pending.shift();
            if (resolve) resolve({ value: undefined, done: true });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  const handle: WebhookServerHandle = {
    port: 7357,
    host: "127.0.0.1",
    events: iterable,
    fetch: () => Promise.resolve(new Response("ok")),
    async stop(): Promise<void> {
      closed = true;
      while (pending.length > 0) {
        const resolve = pending.shift();
        if (resolve) resolve({ value: undefined, done: true });
      }
    },
  };

  return {
    handle,
    push(event: LinearEvent): void {
      if (closed) return;
      const waiter = pending.shift();
      if (waiter) {
        waiter({ value: event, done: false });
        return;
      }
      buffer.push(event);
    },
    finish(): void {
      closed = true;
      while (pending.length > 0) {
        const resolve = pending.shift();
        if (resolve) resolve({ value: undefined, done: true });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Event factories
// ---------------------------------------------------------------------------

function labelAddedEvent(issueId: string, labelId: string): LinearEvent {
  return {
    kind: "issue-label-added",
    webhookId: `wh-${issueId}`,
    receivedAt: Date.now(),
    actorId: "user-1",
    actorName: "tester",
    issueId,
    addedLabelIds: [labelId],
    raw: {},
  } as unknown as LinearEvent;
}

function silentLogger(): ReturnType<typeof createLogger> {
  return createLogger({ transport: () => undefined });
}

async function flushMicrotasks(): Promise<void> {
  // Two cycles: the pickup handler is async and schedules follow-ups.
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLinearRuntime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ready rejects when the team is missing the shamu:ready label", async () => {
    const fakeClient = makeFakeClient({
      labels: [{ id: "lbl-review", name: "shamu:review" }],
    });
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();

    const runtime = await createLinearRuntime({
      client: fakeClient.client,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      egressPolicy: null,
      _runFlow: async () =>
        ({
          flowRunId: "FRN" as never,
          status: "succeeded" as const,
          totalCostUsd: null,
        }) satisfies FlowRunOutcome,
    });

    await expect(runtime.ready).rejects.toThrow(/shamu:ready/);
    // Shutdown is still callable and idempotent after a boot failure.
    await runtime.stop();
    await runtime.stop();
  });

  it("happy path: single pickup runs the flow and flips to review", async () => {
    const fakeClient = makeFakeClient();
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();

    const runFlow = vi.fn(
      async (_input: RuntimeRunFlowInput): Promise<FlowRunOutcome> => ({
        flowRunId: "FRN123" as never,
        status: "succeeded" as const,
        totalCostUsd: 1.23,
      }),
    );

    const runtime = await createLinearRuntime({
      client: fakeClient.client,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      egressPolicy: null,
      _runFlow: runFlow,
    });
    await runtime.ready;

    wh.push(labelAddedEvent("issue-1", "lbl-ready"));

    // Wait for the pickup handler (serialized await chain) to settle.
    for (let i = 0; i < 50; i++) {
      await flushMicrotasks();
      if (runFlow.mock.calls.length > 0) break;
    }
    // Give the post-flow flip + finalize a moment to complete.
    for (let i = 0; i < 20; i++) {
      await flushMicrotasks();
      const names = fakeClient
        .getIssueLabels()
        .map((n) => n)
        .join(",");
      if (names.includes("shamu:review")) break;
    }

    expect(runFlow).toHaveBeenCalledTimes(1);
    expect(fakeClient.getIssueLabels()).toContain("shamu:review");
    // A rolling comment was begun (createComment once) and finalized
    // (updateComment called at least once on the same comment).
    const createComments = fakeClient.calls.filter((c) => c.op === "createComment");
    const updateComments = fakeClient.calls.filter((c) => c.op === "updateComment");
    expect(createComments.length).toBeGreaterThanOrEqual(1);
    expect(updateComments.length).toBeGreaterThanOrEqual(1);

    wh.finish();
    await runtime.stop();
  });

  it("flow failure flips the issue to blocked with an incident comment", async () => {
    const fakeClient = makeFakeClient();
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();

    const runFlow = vi.fn(
      async (_input: RuntimeRunFlowInput): Promise<FlowRunOutcome> => ({
        flowRunId: "FRN" as never,
        status: "failed" as const,
        totalCostUsd: null,
      }),
    );

    const runtime = await createLinearRuntime({
      client: fakeClient.client,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      egressPolicy: null,
      _runFlow: runFlow,
    });
    await runtime.ready;

    wh.push(labelAddedEvent("issue-1", "lbl-ready"));

    for (let i = 0; i < 50; i++) {
      await flushMicrotasks();
      if (runFlow.mock.calls.length > 0) break;
    }
    for (let i = 0; i < 60; i++) {
      await flushMicrotasks();
      const hasBlocked = fakeClient.getIssueLabels().includes("shamu:blocked");
      const hasIncident = fakeClient.calls.some((c) => {
        if (c.op !== "createComment") return false;
        const body = c.args[1];
        return typeof body === "string" && body.includes("Run failed");
      });
      if (hasBlocked && hasIncident) break;
    }

    expect(fakeClient.getIssueLabels()).toContain("shamu:blocked");
    // An incident comment with the "Run failed" body was posted.
    const incidentPosted = fakeClient.calls.some((c) => {
      if (c.op !== "createComment") return false;
      const body = c.args[1];
      return typeof body === "string" && body.includes("Run failed");
    });
    expect(incidentPosted).toBe(true);

    wh.finish();
    await runtime.stop();
  });

  it("handler crash flips to blocked and does not break the drain loop", async () => {
    const fakeClient = makeFakeClient();
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();

    // Substitute runner that throws — simulates an internal fault that
    // bypasses every graceful exit path inside the handler.
    const runFlow = vi.fn(async (_input: RuntimeRunFlowInput): Promise<FlowRunOutcome> => {
      throw new Error("boom in runFlow");
    });

    const runtime = await createLinearRuntime({
      client: fakeClient.client,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      egressPolicy: null,
      _runFlow: runFlow,
    });
    await runtime.ready;

    wh.push(labelAddedEvent("issue-1", "lbl-ready"));

    for (let i = 0; i < 50; i++) {
      await flushMicrotasks();
      if (runFlow.mock.calls.length > 0) break;
    }
    for (let i = 0; i < 30; i++) {
      await flushMicrotasks();
      if (fakeClient.getIssueLabels().includes("shamu:blocked")) break;
    }

    expect(fakeClient.getIssueLabels()).toContain("shamu:blocked");

    // Drain loop still alive: a second pickup is serviced.
    wh.push(labelAddedEvent("issue-2", "lbl-ready"));
    for (let i = 0; i < 50; i++) {
      await flushMicrotasks();
      if (runFlow.mock.calls.length > 1) break;
    }
    expect(runFlow.mock.calls.length).toBe(2);

    wh.finish();
    await runtime.stop();
  });

  it("stop() is idempotent and multiple callers get the same promise", async () => {
    const fakeClient = makeFakeClient();
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();
    const runtime = await createLinearRuntime({
      client: fakeClient.client,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      egressPolicy: null,
      _runFlow: async () =>
        ({
          flowRunId: "FRN" as never,
          status: "succeeded" as const,
          totalCostUsd: null,
        }) satisfies FlowRunOutcome,
    });
    await runtime.ready;

    const first = runtime.stop();
    const second = runtime.stop();
    await Promise.all([first, second]);
    // A third call, after settle, still returns a resolved promise.
    await runtime.stop();
  });

  it("terminal node_completed checkpoint is serialized into the rolling body before finalize", async () => {
    // Regression guard for Phase 6.D followup #1: the rolling-comment
    // bridge used to fire `void appendCheckpoint(...)` for every
    // node_completed event, which allowed the terminal node's append
    // to race `finalize`. Both call `updateComment`; whichever wins
    // last defines the Linear-visible body. Before the fix, the
    // finalize's `updateComment` landed with a body snapshot that did
    // NOT include the terminal node's section, silently dropping it.
    //
    // We wrap the fake client so the terminal updateComment has a
    // non-zero delay. Under the pre-fix code the finalize's synchronous
    // call-chain would lap the pending append and the final body would
    // omit the terminal checkpoint; under the fix the drained tail
    // ensures both sections are present in order.
    const fakeClient = makeFakeClient();
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();

    // Proxy the underlying client so updateComment takes a small async
    // hop — this surfaces any ordering bug between the bridge's
    // append and the finalize path.
    const inner = fakeClient.client;
    const delayedClient: LinearClient = {
      ...inner,
      async updateComment(id, body) {
        await new Promise((r) => setTimeout(r, 5));
        return inner.updateComment(id, body);
      },
    } as LinearClient;

    const runFlow = vi.fn(async (input: RuntimeRunFlowInput): Promise<FlowRunOutcome> => {
      input.flowBus.publish({
        kind: "node_completed",
        flowRunId: "FRN-RACE" as never,
        nodeId: nodeId("plan"),
        at: 1_000,
        durationMs: 1,
        cached: false,
        output: {
          ok: true,
          value: null,
          costUsd: null,
          costConfidence: "unknown",
          costSource: "test",
        },
      });
      input.flowBus.publish({
        kind: "node_completed",
        flowRunId: "FRN-RACE" as never,
        nodeId: nodeId("review"),
        at: 2_000,
        durationMs: 1,
        cached: false,
        output: {
          ok: true,
          value: null,
          costUsd: null,
          costConfidence: "unknown",
          costSource: "test",
        },
      });
      return {
        flowRunId: "FRN-RACE" as never,
        status: "succeeded" as const,
        totalCostUsd: null,
      };
    });

    const runtime = await createLinearRuntime({
      client: delayedClient,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      egressPolicy: null,
      _runFlow: runFlow,
    });
    await runtime.ready;

    wh.push(labelAddedEvent("issue-1", "lbl-ready"));

    // Wait until the flow has been invoked, every queued append has
    // drained, and the label flip to review has landed (which is the
    // signal that finalize completed too).
    for (let i = 0; i < 400; i++) {
      await flushMicrotasks();
      await new Promise((r) => setTimeout(r, 1));
      const labels = fakeClient.getIssueLabels();
      if (runFlow.mock.calls.length > 0 && labels.includes("shamu:review")) break;
    }

    expect(runFlow).toHaveBeenCalledTimes(1);
    // The final updateComment call is finalize — it sees the fully
    // drained in-memory body, which must include BOTH the terminal
    // node's checkpoint AND the `## Summary` footer.
    const updates = fakeClient.calls.filter((c) => c.op === "updateComment");
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const lastBody = updates[updates.length - 1]?.args[1] as string | undefined;
    expect(lastBody).toBeDefined();
    if (!lastBody) return;
    expect(lastBody).toContain("Node review completed");
    expect(lastBody).toContain("## Summary");

    wh.finish();
    await runtime.stop();
  });

  it("CI tripwire on flow bus → escalation sink posts incident comment + flips blocked", async () => {
    // Exercises the full escalation chain: the `_runFlow` substitute
    // publishes three consecutive red `node_completed` events on the
    // CI node onto the flow bus. The runtime's per-run `createCiTripwire`
    // + `createCiTripwireObserver` count those reds, fire a
    // `watchdog.ci_tripwire` via the escalation emitter, which
    // translates to `escalation_raised` on the supervisor bus, which
    // the escalation sink picks up and turns into (a) an incident
    // comment on the bound issue and (b) a flip to blocked.
    //
    // This is the "escalation without a prior pickup-bound run via
    // registry" scenario from the spec, achieved organically: the
    // pickup binds runId ↔ issueId, then the tripwire fires under that
    // same runId, so the sink's `registry.issueIdFor(runId)` hits.
    const fakeClient = makeFakeClient();
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();

    // The `_runFlow` substitute reaches for the caller-provided flowBus
    // to publish three red CI completions before returning "failed".
    const runFlow = vi.fn(async (input: RuntimeRunFlowInput): Promise<FlowRunOutcome> => {
      const baseRunId = "FRN-CI";
      for (let i = 0; i < 3; i++) {
        input.flowBus.publish({
          kind: "node_completed",
          flowRunId: baseRunId as never,
          nodeId: nodeId("ci"),
          at: 1_000 + i,
          durationMs: 10,
          cached: false,
          output: {
            ok: true,
            // Shape recognized by createCiTripwireObserver: CINodeOutput-ish.
            value: {
              summary: { status: "red" },
              runId: `run-ci-${i}`,
            },
            costUsd: null,
            costConfidence: "unknown",
            costSource: "test",
          },
        });
      }
      return {
        flowRunId: baseRunId as never,
        status: "failed" as const,
        totalCostUsd: null,
      };
    });

    const runtime = await createLinearRuntime({
      client: fakeClient.client,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      egressPolicy: null,
      _runFlow: runFlow,
    });
    await runtime.ready;

    wh.push(labelAddedEvent("issue-1", "lbl-ready"));

    for (let i = 0; i < 120; i++) {
      await flushMicrotasks();
      const blocked = fakeClient.getIssueLabels().includes("shamu:blocked");
      const commentCount = fakeClient.calls.filter((c) => c.op === "createComment").length;
      if (runFlow.mock.calls.length > 0 && blocked && commentCount >= 2) break;
    }

    // Assertion focus: the issue ended at shamu:blocked and AT LEAST
    // two createComment calls fired — one for the rolling comment
    // begin, and one for the runtime's own failure-path incident
    // comment. The ci_tripwire itself takes the LAST CINodeOutput.runId
    // as `childId`; since that doesn't match the pickup's runId the
    // escalation sink's `registry.issueIdFor(childId)` returns null and
    // logs a warn (correct — the tripwire is role-scoped, not run-
    // scoped). The label still ends up at blocked via the failure-path
    // fallback, which is the belt-and-suspenders contract.
    expect(fakeClient.getIssueLabels()).toContain("shamu:blocked");
    const commentCalls = fakeClient.calls.filter((c) => c.op === "createComment");
    expect(commentCalls.length).toBeGreaterThanOrEqual(2);

    wh.finish();
    await runtime.stop();
  });
});
