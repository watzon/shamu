/**
 * Concurrency tests for `createLinearRuntime`.
 *
 * Exercises the Phase 8.A rate-limiter wiring:
 *
 *   - Two simultaneous `shamu:ready` events with executor cap=2 produce
 *     two concurrent runs (both `runFlow` calls are pending at the same
 *     time).
 *   - A third arrival queues (pending length increments).
 *   - A fourth overflows and flips `shamu:blocked`.
 *
 * The harness controls when each `runFlow` call resolves so we can
 * observe interleaving deterministically. `_withEgressBroker` is
 * substituted with a no-op (avoids real socket binds in unit tests).
 */

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
import { describe, expect, it } from "vitest";
import type { FlowRunOutcome } from "../../src/services/flow-runner.ts";
import {
  createLinearRuntime,
  type RuntimeRunFlowInput,
} from "../../src/services/linear-runtime.ts";
import { createFakeFlowDb } from "../helpers/fake-db.ts";

// ---------------------------------------------------------------------------
// Helpers (mirror linear-runtime.test.ts intentionally — do NOT share since
// the other file scopes its helpers module-private).
// ---------------------------------------------------------------------------

interface FakeClient {
  readonly client: LinearClient;
  readonly calls: Array<{ op: string; args: readonly unknown[] }>;
  getLabels(issueId: string): ReadonlySet<string>;
}

function makeFakeClient(): FakeClient {
  const calls: Array<{ op: string; args: readonly unknown[] }> = [];
  const labels: Label[] = [
    { id: "lbl-ready", name: "shamu:ready" },
    { id: "lbl-in-progress", name: "shamu:in-progress" },
    { id: "lbl-review", name: "shamu:review" },
    { id: "lbl-blocked", name: "shamu:blocked" },
  ];
  const issueLabels = new Map<string, Set<string>>();

  function ensure(issueId: string): Set<string> {
    let set = issueLabels.get(issueId);
    if (!set) {
      set = new Set<string>();
      issueLabels.set(issueId, set);
    }
    return set;
  }

  const client = {
    async listLabels(teamId: string): Promise<Result<Label[], LinearError>> {
      calls.push({ op: "listLabels", args: [teamId] });
      return ok([...labels]);
    },
    async getIssue(id: string): Promise<Result<Issue, LinearError>> {
      calls.push({ op: "getIssue", args: [id] });
      const set = ensure(id);
      return ok({
        id,
        identifier: id,
        title: `Issue ${id}`,
        description: null,
        url: `https://linear.app/t/${id}`,
        teamId: "team-1",
        stateId: "state-1",
        stateName: "Todo",
        labelIds: [...set].map((_n, i) => `lbl-${i}`),
        labelNames: [...set],
      });
    },
    async addLabel(issueId: string, labelName: string): Promise<Result<true, LinearError>> {
      calls.push({ op: "addLabel", args: [issueId, labelName] });
      ensure(issueId).add(labelName);
      return ok(true);
    },
    async removeLabel(issueId: string, labelName: string): Promise<Result<true, LinearError>> {
      calls.push({ op: "removeLabel", args: [issueId, labelName] });
      ensure(issueId).delete(labelName);
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
    getLabels(issueId: string): ReadonlySet<string> {
      return ensure(issueId);
    },
  };
}

interface FakeWebhookServer {
  readonly handle: WebhookServerHandle;
  push(event: LinearEvent): void;
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

async function waitUntil(predicate: () => boolean, timeoutMs = 2000, stepMs = 1): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil: timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

interface ControlledRunFlow {
  readonly runFlow: (input: RuntimeRunFlowInput) => Promise<FlowRunOutcome>;
  /** Count of calls that are currently pending (awaiting resolve). */
  pendingCount(): number;
  /** Total invocations (including settled). */
  invocationCount(): number;
  /** Resolve the oldest pending call with a success outcome. */
  resolveOldest(): void;
}

function makeControlledRunFlow(): ControlledRunFlow {
  const pending: Array<(value: FlowRunOutcome) => void> = [];
  let invocations = 0;
  const runFlow = (_input: RuntimeRunFlowInput): Promise<FlowRunOutcome> => {
    invocations += 1;
    return new Promise<FlowRunOutcome>((resolve) => {
      pending.push(resolve);
    });
  };
  return {
    runFlow,
    pendingCount: () => pending.length,
    invocationCount: () => invocations,
    resolveOldest(): void {
      const resolve = pending.shift();
      if (resolve) {
        resolve({
          flowRunId: "FRN" as never,
          status: "succeeded" as const,
          totalCostUsd: null,
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLinearRuntime (concurrent pickups)", () => {
  it("two pickups with executor cap=2 run concurrently", async () => {
    const fakeClient = makeFakeClient();
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();
    const ctrl = makeControlledRunFlow();

    const runtime = await createLinearRuntime({
      client: fakeClient.client,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      egressPolicy: null,
      concurrency: { globalCap: 3, perRoleCap: { executor: 2 }, queueCapacity: 4 },
      _runFlow: ctrl.runFlow,
    });
    await runtime.ready;

    wh.push(labelAddedEvent("issue-1", "lbl-ready"));
    wh.push(labelAddedEvent("issue-2", "lbl-ready"));

    // Both pickups eventually reach `runFlow`. Polling with real setTimeout
    // lets the microtask + IO chains complete.
    await waitUntil(() => ctrl.invocationCount() === 2);
    expect(ctrl.pendingCount()).toBe(2);
    expect(runtime.inFlight).toBe(2);

    // Resolve both.
    ctrl.resolveOldest();
    ctrl.resolveOldest();
    await waitUntil(() => runtime.inFlight === 0);

    wh.finish();
    await runtime.stop();
  });

  it("third pickup queues while cap=2 saturated; overflow flips blocked", async () => {
    const fakeClient = makeFakeClient();
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();
    const ctrl = makeControlledRunFlow();

    const runtime = await createLinearRuntime({
      client: fakeClient.client,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      egressPolicy: null,
      // executor cap 2, queue capacity 1: the 3rd pickup queues; the 4th
      // overflows.
      concurrency: { globalCap: 2, perRoleCap: { executor: 2 }, queueCapacity: 1 },
      _runFlow: ctrl.runFlow,
    });
    await runtime.ready;

    wh.push(labelAddedEvent("issue-1", "lbl-ready"));
    wh.push(labelAddedEvent("issue-2", "lbl-ready"));
    // Wait for both to acquire tokens.
    await waitUntil(() => ctrl.invocationCount() === 2 && runtime.inFlight === 2);

    // Third pickup — should queue, NOT invoke runFlow yet.
    wh.push(labelAddedEvent("issue-3", "lbl-ready"));
    // Fourth pickup — overflows the queue.
    wh.push(labelAddedEvent("issue-4", "lbl-ready"));

    // Wait for issue-4 to be flipped to blocked.
    await waitUntil(() => fakeClient.getLabels("issue-4").has("shamu:blocked"));
    expect(fakeClient.getLabels("issue-4").has("shamu:blocked")).toBe(true);

    // runFlow should still have only 2 invocations (the third is queued,
    // the fourth was rejected).
    expect(ctrl.invocationCount()).toBe(2);

    // Resolve oldest — one slot frees up; third pickup's invocation
    // should follow.
    ctrl.resolveOldest();
    await waitUntil(() => ctrl.invocationCount() === 3);

    // Cleanup.
    ctrl.resolveOldest();
    ctrl.resolveOldest();
    await waitUntil(() => runtime.inFlight === 0);

    wh.finish();
    await runtime.stop();
  });
});
