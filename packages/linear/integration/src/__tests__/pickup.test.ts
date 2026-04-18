/**
 * Unit tests for `createPickupDriver`.
 *
 * We build an in-memory `WebhookServerHandle` shim that forwards events from
 * a test-controlled queue. Tests use it to exercise: filter-by-label-id,
 * non-label events are dropped, sequential back-pressure, handler-throw
 * doesn't break the loop, clean `stop()`, and natural `done` resolution on
 * iterator close.
 */

import type { LinearEvent, WebhookServerHandle } from "@shamu/linear-webhook";
import { runId as brandRunId, type RunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { createPickupDriver } from "../pickup.ts";
import { createRunIssueRegistry } from "../registry.ts";
import type { LinearPickup } from "../types.ts";

// ---------------------------------------------------------------------------
// Minimal in-memory webhook handle
// ---------------------------------------------------------------------------

interface TestHandle extends WebhookServerHandle {
  push(event: LinearEvent): void;
  /** Close the iterator (like the real server does on stop). */
  finish(): void;
}

function makeFakeHandle(): TestHandle {
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

  return {
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
// Event fixture helpers
// ---------------------------------------------------------------------------

function labelAdded(
  issueId: string,
  addedLabelIds: readonly string[],
  webhookId = `wh-${issueId}`,
): LinearEvent {
  return {
    kind: "issue-label-added",
    webhookTimestamp: 1_700_000_000_000,
    webhookId,
    issueId,
    labelIds: addedLabelIds,
    addedLabelIds,
    raw: {
      action: "update",
      type: "Issue",
      webhookTimestamp: 1_700_000_000_000,
      webhookId,
      data: { id: issueId, labelIds: addedLabelIds },
      updatedFrom: { labelIds: [] },
    },
  };
}

function commentCreated(): LinearEvent {
  return {
    kind: "comment-created",
    webhookTimestamp: 1_700_000_000_000,
    webhookId: "wh-comment",
    commentId: "c1",
    issueId: "issue-99",
    body: "hi",
    userId: null,
    raw: {
      action: "create",
      type: "Comment",
      webhookTimestamp: 1_700_000_000_000,
      webhookId: "wh-comment",
      data: { id: "c1", issueId: "issue-99", body: "hi" },
    },
  };
}

// Counter-based runId minter for deterministic assertions.
function counterMint(): () => RunId {
  let i = 0;
  return () => brandRunId(`run-${++i}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPickupDriver", () => {
  it("drains a single label-added event and fires onPickup", async () => {
    const handle = makeFakeHandle();
    const registry = createRunIssueRegistry();
    const pickups: LinearPickup[] = [];
    const driver = createPickupDriver({
      handle,
      registry,
      isReadyLabelId: (id) => id === "ready-id",
      newRunId: counterMint(),
      now: () => 42,
      onPickup: (p) => {
        pickups.push(p);
      },
    });
    handle.push(labelAdded("issue-1", ["ready-id"]));
    // Yield so the driver loop can pick up the pushed event.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    handle.finish();
    await driver.done;
    expect(pickups).toHaveLength(1);
    expect(pickups[0]).toMatchObject({
      kind: "linear.pickup",
      issueId: "issue-1",
      runId: "run-1",
      at: 42,
    });
    expect(registry.issueIdFor(brandRunId("run-1"))).toBe("issue-1");
  });

  it("filters by label id via the predicate (skips non-ready label adds)", async () => {
    const handle = makeFakeHandle();
    const registry = createRunIssueRegistry();
    const pickups: LinearPickup[] = [];
    const driver = createPickupDriver({
      handle,
      registry,
      isReadyLabelId: (id) => id === "ready-id",
      newRunId: counterMint(),
      onPickup: (p) => {
        pickups.push(p);
      },
    });
    handle.push(labelAdded("issue-ignore", ["bug-id"]));
    handle.push(labelAdded("issue-take", ["ready-id"]));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    handle.finish();
    await driver.done;
    expect(pickups).toHaveLength(1);
    expect(pickups[0]?.issueId).toBe("issue-take");
  });

  it("ignores non-label-added events (comment-created)", async () => {
    const handle = makeFakeHandle();
    const registry = createRunIssueRegistry();
    const pickups: LinearPickup[] = [];
    const driver = createPickupDriver({
      handle,
      registry,
      isReadyLabelId: () => true,
      onPickup: (p) => {
        pickups.push(p);
      },
    });
    handle.push(commentCreated());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    handle.finish();
    await driver.done;
    expect(pickups).toHaveLength(0);
  });

  it("drops label-added events when no predicate is wired", async () => {
    const handle = makeFakeHandle();
    const registry = createRunIssueRegistry();
    const pickups: LinearPickup[] = [];
    const driver = createPickupDriver({
      handle,
      registry,
      // isReadyLabelId intentionally omitted.
      onPickup: (p) => {
        pickups.push(p);
      },
    });
    handle.push(labelAdded("issue-1", ["ready-id"]));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    handle.finish();
    await driver.done;
    expect(pickups).toHaveLength(0);
  });

  it("awaits onPickup sequentially — handler ordering preserved", async () => {
    const handle = makeFakeHandle();
    const registry = createRunIssueRegistry();
    const completedOrder: string[] = [];
    const driver = createPickupDriver({
      handle,
      registry,
      isReadyLabelId: () => true,
      newRunId: counterMint(),
      onPickup: async (p) => {
        // First handler takes longer than the second would; sequential
        // await must preserve the arrival order regardless.
        const delay = p.issueId === "issue-slow" ? 20 : 1;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        completedOrder.push(p.issueId);
      },
    });
    handle.push(labelAdded("issue-slow", ["ready-id"]));
    handle.push(labelAdded("issue-fast", ["ready-id"]));
    // Allow both events to be processed.
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    handle.finish();
    await driver.done;
    expect(completedOrder).toEqual(["issue-slow", "issue-fast"]);
  });

  it("stop() resolves and prevents further events from being processed", async () => {
    const handle = makeFakeHandle();
    const registry = createRunIssueRegistry();
    const pickups: LinearPickup[] = [];
    const driver = createPickupDriver({
      handle,
      registry,
      isReadyLabelId: () => true,
      newRunId: counterMint(),
      onPickup: (p) => {
        pickups.push(p);
      },
    });
    handle.push(labelAdded("issue-1", ["ready-id"]));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await driver.stop();
    // After stop, pushing another event should not reach onPickup because
    // the iterator has been `return()`'d.
    handle.push(labelAdded("issue-2", ["ready-id"]));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(pickups.map((p) => p.issueId)).toEqual(["issue-1"]);
    // Calling stop() again is idempotent.
    await driver.stop();
  });

  it("done resolves when the iterator completes naturally (no stop call)", async () => {
    const handle = makeFakeHandle();
    const registry = createRunIssueRegistry();
    const driver = createPickupDriver({
      handle,
      registry,
      isReadyLabelId: () => true,
      newRunId: counterMint(),
      onPickup: () => undefined,
    });
    handle.finish();
    // Should resolve without needing stop().
    await driver.done;
  });

  it("handler throw does not break the drain loop", async () => {
    const handle = makeFakeHandle();
    const registry = createRunIssueRegistry();
    const seen: string[] = [];
    const driver = createPickupDriver({
      handle,
      registry,
      isReadyLabelId: () => true,
      newRunId: counterMint(),
      onPickup: (p) => {
        seen.push(p.issueId);
        if (p.issueId === "issue-boom") throw new Error("handler boom");
      },
    });
    handle.push(labelAdded("issue-boom", ["ready-id"]));
    handle.push(labelAdded("issue-ok", ["ready-id"]));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    handle.finish();
    await driver.done;
    expect(seen).toEqual(["issue-boom", "issue-ok"]);
  });
});
