/**
 * Drain tests for `createLinearRuntime`.
 *
 *   - `pause()` stops new pickups but lets in-flight runs complete.
 *   - `drainAndStop(short deadline)` cancels still-running flows via
 *     their AbortController and flips the bound issue to
 *     `shamu:blocked` with the drain reason.
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

/** Signal-aware runFlow that honors the AbortSignal. */
function signalAwareRunFlow(): {
  readonly runFlow: (input: RuntimeRunFlowInput) => Promise<FlowRunOutcome>;
  readonly pending: ReadonlyArray<{ signal: AbortSignal; issueIdTaskHint: string }>;
  resolveOldest(): void;
  count(): number;
} {
  const pending: Array<{
    signal: AbortSignal;
    resolve: (value: FlowRunOutcome) => void;
    reject: (cause: unknown) => void;
    issueIdTaskHint: string;
  }> = [];
  const runFlow = (input: RuntimeRunFlowInput): Promise<FlowRunOutcome> => {
    return new Promise<FlowRunOutcome>((resolve, reject) => {
      const entry = {
        signal: input.signal,
        resolve,
        reject,
        issueIdTaskHint: input.task,
      };
      pending.push(entry);
      const onAbort = (): void => {
        reject(new Error("aborted"));
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  return {
    runFlow,
    pending,
    resolveOldest(): void {
      const entry = pending.shift();
      if (entry) {
        entry.resolve({
          flowRunId: "FRN" as never,
          status: "succeeded" as const,
          totalCostUsd: null,
        });
      }
    },
    count(): number {
      return pending.length;
    },
  };
}

describe("createLinearRuntime (drain)", () => {
  it("pause() stops new pickups but lets in-flight runs finish", async () => {
    const fakeClient = makeFakeClient();
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();
    const ctrl = signalAwareRunFlow();

    const runtime = await createLinearRuntime({
      client: fakeClient.client,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      egressPolicy: null,
      concurrency: { globalCap: 3, perRoleCap: { executor: 3 }, queueCapacity: 4 },
      _runFlow: ctrl.runFlow,
    });
    await runtime.ready;

    wh.push(labelAddedEvent("issue-1", "lbl-ready"));
    await waitUntil(() => runtime.inFlight === 1);
    expect(ctrl.count()).toBe(1);

    runtime.pause();

    // Post-pause pickup ignored.
    wh.push(labelAddedEvent("issue-2", "lbl-ready"));
    await new Promise((r) => setTimeout(r, 20));
    expect(ctrl.count()).toBe(1);
    expect(runtime.inFlight).toBe(1);

    // The existing in-flight run should still be able to finish.
    ctrl.resolveOldest();
    await waitUntil(() => runtime.inFlight === 0);

    wh.finish();
    await runtime.stop();
  });

  it("drainAndStop(0) cancels in-flight runs and flips them to blocked", async () => {
    const fakeClient = makeFakeClient();
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();
    const ctrl = signalAwareRunFlow();

    const runtime = await createLinearRuntime({
      client: fakeClient.client,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      egressPolicy: null,
      concurrency: { globalCap: 3, perRoleCap: { executor: 3 }, queueCapacity: 4 },
      _runFlow: ctrl.runFlow,
    });
    await runtime.ready;

    wh.push(labelAddedEvent("issue-1", "lbl-ready"));
    await waitUntil(() => runtime.inFlight === 1);

    // drainAndStop(0) — immediate cancel. The signal should fire; the
    // handler's post-cancel finalize path flips to blocked.
    await runtime.drainAndStop(0);

    expect(runtime.inFlight).toBe(0);
    expect(fakeClient.getLabels("issue-1").has("shamu:blocked")).toBe(true);
    // The drain-reason comment was posted.
    const sawDrainReason = fakeClient.calls.some((c) => {
      if (c.op !== "createComment") return false;
      const body = c.args[1];
      return typeof body === "string" && body.includes("drained before completion");
    });
    expect(sawDrainReason).toBe(true);

    wh.finish();
    await runtime.stop();
  });

  it("drainAndStop(deadlineMs) waits for in-flight runs before cancelling", async () => {
    const fakeClient = makeFakeClient();
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();
    const ctrl = signalAwareRunFlow();

    const runtime = await createLinearRuntime({
      client: fakeClient.client,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      egressPolicy: null,
      concurrency: { globalCap: 3, perRoleCap: { executor: 3 }, queueCapacity: 4 },
      _runFlow: ctrl.runFlow,
    });
    await runtime.ready;

    wh.push(labelAddedEvent("issue-1", "lbl-ready"));
    await waitUntil(() => runtime.inFlight === 1);

    // Start drain with a short deadline (50ms) — the run hasn't resolved,
    // so the deadline trips and the run gets cancelled. We schedule a
    // resolve BEFORE the deadline so the test covers the "run completes
    // in time" path.
    setTimeout(() => ctrl.resolveOldest(), 5);
    await runtime.drainAndStop(200);

    expect(runtime.inFlight).toBe(0);
    // The run completed normally → issue flipped to review (not blocked).
    expect(fakeClient.getLabels("issue-1").has("shamu:review")).toBe(true);
    expect(fakeClient.getLabels("issue-1").has("shamu:blocked")).toBe(false);

    wh.finish();
  });
});
