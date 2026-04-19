/**
 * Egress-broker wiring test for `createLinearRuntime`.
 *
 * Exercises the Phase 8.A per-run broker lifecycle + the
 * `denied → escalation_raised` route through the supervisor bus into
 * the escalation sink (incident comment + flip blocked).
 *
 * `_withEgressBroker` is stubbed so we can synthesize a `denied` event
 * without actually standing up a proxy socket.
 */

import type { SpawnOpts } from "@shamu/adapters-base/adapter";
import type {
  EgressBrokerHandle,
  EgressEventListener,
  EgressEventMap,
  EgressPolicy,
  PolicyEgressAllowedEvent,
  PolicyEgressDeniedEvent,
} from "@shamu/egress-broker";
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

function makeFakeClient(): {
  client: LinearClient;
  calls: Array<{ op: string; args: readonly unknown[] }>;
  getLabels: (issueId: string) => ReadonlySet<string>;
} {
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
    getLabels: (issueId) => ensure(issueId),
  };
}

function makeFakeWebhookServer(): {
  handle: WebhookServerHandle;
  push: (ev: LinearEvent) => void;
  finish: () => void;
} {
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
    push(event): void {
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

/**
 * Stubbed `_withEgressBroker` that:
 *   - Increments a start counter.
 *   - Captures the `onEvent` callback so the test can drive a synthetic
 *     `denied` event into the runtime.
 *   - Returns a shutdown that increments a shutdown counter.
 */
interface BrokerStub {
  readonly startCount: { count: number };
  readonly shutdownCount: { count: number };
  readonly lastBase: { opts: SpawnOpts | null };
  readonly stub: (arg: {
    readonly policy: EgressPolicy;
    readonly baseSpawnOpts: SpawnOpts;
    readonly onEvent?: (
      type: "allowed" | "denied",
      event: PolicyEgressAllowedEvent | PolicyEgressDeniedEvent,
    ) => void;
  }) => Promise<{
    readonly brokerHandle: EgressBrokerHandle;
    readonly spawnOpts: SpawnOpts;
    shutdown(): Promise<void>;
  }>;
  fireDenied(ev: PolicyEgressDeniedEvent): void;
}

function makeBrokerStub(): BrokerStub {
  const startCount = { count: 0 };
  const shutdownCount = { count: 0 };
  const lastBase: { opts: SpawnOpts | null } = { opts: null };
  const handlers: Array<
    (type: "allowed" | "denied", event: PolicyEgressAllowedEvent | PolicyEgressDeniedEvent) => void
  > = [];
  const brokerHandle: EgressBrokerHandle = {
    async start(): Promise<void> {
      return;
    },
    async shutdown(): Promise<void> {
      return;
    },
    get url(): string {
      return "http://127.0.0.1:0";
    },
    get port(): number {
      return 0;
    },
    on<K extends keyof EgressEventMap>(_event: K, _listener: EgressEventListener<K>): () => void {
      return () => undefined;
    },
    get policy(): EgressPolicy {
      return { defaultPolicy: "deny", allowedHosts: [], allowedHostSuffixes: [] };
    },
  };
  return {
    startCount,
    shutdownCount,
    lastBase,
    stub: async (arg) => {
      startCount.count += 1;
      lastBase.opts = arg.baseSpawnOpts;
      if (arg.onEvent) handlers.push(arg.onEvent);
      return {
        brokerHandle,
        spawnOpts: arg.baseSpawnOpts,
        async shutdown(): Promise<void> {
          shutdownCount.count += 1;
        },
      };
    },
    fireDenied(ev): void {
      for (const h of handlers) h("denied", ev);
    },
  };
}

describe("createLinearRuntime (egress broker)", () => {
  it("starts + shuts down a broker per run", async () => {
    const fakeClient = makeFakeClient();
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();
    const broker = makeBrokerStub();

    const runtime = await createLinearRuntime({
      client: fakeClient.client,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      _withEgressBroker:
        broker.stub as unknown as typeof import("@shamu/core-composition").withEgressBroker,
      _runFlow: async (_input: RuntimeRunFlowInput): Promise<FlowRunOutcome> => ({
        flowRunId: "FRN" as never,
        status: "succeeded" as const,
        totalCostUsd: null,
      }),
    });
    await runtime.ready;

    wh.push(labelAddedEvent("issue-1", "lbl-ready"));
    await waitUntil(() => broker.shutdownCount.count === 1);
    expect(broker.startCount.count).toBe(1);
    expect(broker.shutdownCount.count).toBe(1);
    expect(broker.lastBase.opts?.cwd).toBeDefined();
    expect(broker.lastBase.opts?.runId).toBeDefined();

    wh.finish();
    await runtime.stop();
  });

  it("broker denied events flip the issue to blocked via the escalation sink", async () => {
    const fakeClient = makeFakeClient();
    const wh = makeFakeWebhookServer();
    const db = createFakeFlowDb();
    const broker = makeBrokerStub();

    // Keep the run parked so the broker's onEvent callback is still
    // registered when we fire a denied event.
    const pending: Array<(v: FlowRunOutcome) => void> = [];
    const runtime = await createLinearRuntime({
      client: fakeClient.client,
      teamId: "team-1",
      webhookServer: wh.handle,
      db,
      logger: silentLogger(),
      _withEgressBroker:
        broker.stub as unknown as typeof import("@shamu/core-composition").withEgressBroker,
      _runFlow: (_input: RuntimeRunFlowInput): Promise<FlowRunOutcome> => {
        return new Promise<FlowRunOutcome>((resolve) => {
          pending.push(resolve);
        });
      },
    });
    await runtime.ready;

    wh.push(labelAddedEvent("issue-1", "lbl-ready"));
    // Wait until the broker has been started for this pickup AND the
    // handler has bound the run id in the registry (so the escalation
    // sink can resolve the issueId).
    await waitUntil(() => broker.startCount.count === 1 && runtime.inFlight === 1);

    // Fire a synthetic denied event — should route through the supervisor
    // bus into the escalation sink.
    broker.fireDenied({
      type: "policy.egress_denied",
      ts: Date.now(),
      proxyMethod: "CONNECT",
      rawTarget: "evil.example.com:443",
      host: "evil.example.com",
      port: 443,
      reason: "host_not_allowlisted",
    });

    // Escalation sink response: new comment on issue-1 + flip to blocked.
    await waitUntil(() => fakeClient.getLabels("issue-1").has("shamu:blocked"));
    const sawEgressComment = fakeClient.calls.some((c) => {
      if (c.op !== "createComment") return false;
      const body = c.args[1];
      return typeof body === "string" && body.toLowerCase().includes("policy violation");
    });
    expect(sawEgressComment).toBe(true);

    // Let the run complete so the test tears down cleanly.
    const resolve = pending.shift();
    if (resolve) {
      resolve({
        flowRunId: "FRN" as never,
        status: "succeeded" as const,
        totalCostUsd: null,
      });
    }
    await waitUntil(() => runtime.inFlight === 0);

    wh.finish();
    await runtime.stop();
  });
});
