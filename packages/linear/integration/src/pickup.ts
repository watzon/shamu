/**
 * Webhook pickup driver — drains the `@shamu/linear-webhook` async iterator
 * and turns `shamu:ready` label-added events into `LinearPickup` emissions.
 *
 * Back-pressure model:
 *
 *   The driver runs one sequential `for await` loop. Each event is
 *   dispatched to the consumer's `onPickup` callback, and the driver awaits
 *   that callback before reading the next event. If `onPickup` is slow,
 *   the webhook server's sink buffer grows; if the sink buffer fills up
 *   faster than the driver drains, Linear will eventually stop delivering
 *   (every webhook delivery is retried until ack'd, but Linear drops POSTs
 *   we never respond to after a few minutes). That's the designed
 *   back-pressure: a slow consumer surfaces as webhook-level drop + retry,
 *   which is benign because Linear replays.
 *
 *   Followup #4 in HANDOFF tracks adding a real bounded queue if we see
 *   real-world slow consumers; for now, sequential-await is the simplest
 *   correct implementation.
 *
 * Label-name resolution:
 *
 *   The webhook gives us `addedLabelIds` (not names). Name resolution
 *   requires the team context, which lives on the `LinearClient` — but the
 *   driver doesn't take a client dependency (that would tangle the layering
 *   and force Phase 6.C.3 wiring decisions in here). Instead, the driver
 *   accepts an optional `isReadyLabelId` predicate. If omitted, the driver
 *   logs + drops every `issue-label-added` event (cannot identify the
 *   ready label without team context). 6.C.3 supplies the predicate after
 *   resolving the team's `shamu:ready` label via `LinearClient.listLabels`.
 *
 * Cancellation:
 *
 *   The webhook's `EventSink.iterable` implements `return()` — calling it
 *   settles any pending `next()` to `{ done: true }`. We rely on that here:
 *   `stop()` flips an internal flag AND explicitly returns the iterator if
 *   it's parked on a pending pull. `for await ... break` handles the
 *   common case. We never synthesize an AbortController because the sink
 *   already supports cooperative cancellation.
 */

import type { IssueLabelAddedEvent, WebhookServerHandle } from "@shamu/linear-webhook";
import type { RunId } from "@shamu/shared/ids";
import { newRunId } from "@shamu/shared/ids";
import type { Logger } from "@shamu/shared/logger";
import type { RunIssueRegistry } from "./registry.ts";
import type { LinearPickup } from "./types.ts";

export interface PickupDriverOptions {
  readonly handle: WebhookServerHandle;
  readonly registry: RunIssueRegistry;
  /** Default `"shamu:ready"`. Purely informational (logged on mismatch). */
  readonly readyLabel?: string;
  /**
   * Predicate that returns true iff the given label id is the ready label
   * for its team. When omitted, every label-added event is logged + dropped
   * (we can't resolve names without team context). 6.C.3 supplies this.
   */
  readonly isReadyLabelId?: (labelId: string) => boolean;
  /** Mint a fresh run id per pickup. Default: `@shamu/shared/ids.newRunId`. */
  readonly newRunId?: () => RunId;
  /** Fired on every successful pickup. Awaited → back-pressures the drain. */
  readonly onPickup: (pickup: LinearPickup) => void | Promise<void>;
  /** Injected clock. */
  readonly now?: () => number;
  /** Optional logger for dropped / filtered events. */
  readonly logger?: Logger;
}

export interface PickupDriverHandle {
  /** Stop the drain loop. Idempotent. Resolves after any in-flight event. */
  stop(): Promise<void>;
  /** Resolves when the drain loop exits (e.g. the iterator is closed). */
  readonly done: Promise<void>;
}

export function createPickupDriver(opts: PickupDriverOptions): PickupDriverHandle {
  const mint = opts.newRunId ?? newRunId;
  const now = opts.now ?? Date.now;
  const readyLabel = opts.readyLabel ?? "shamu:ready";
  const logger = opts.logger;
  let stopped = false;
  // Keep a reference to the active iterator so `stop()` can call `return()`
  // on the iterator parked inside `for await`, unblocking it without having
  // to send a sentinel event through the sink.
  let activeIterator: AsyncIterator<IssueLabelAddedEvent["raw"]> | null = null;

  async function drain(): Promise<void> {
    // We iterate the base `events` iterable directly so we can hold onto
    // the iterator for cancellation (a plain `for await` makes that
    // awkward). The element type is `LinearEvent`, not just `IssueLabelAddedEvent`.
    const iterator = opts.handle.events[Symbol.asyncIterator]();
    // Safe cast — we don't touch the event shape on the iterator, we just
    // want a handle for `return()` during `stop()`. TS forbids assigning
    // `AsyncIterator<LinearEvent>` to the narrowed type above directly, so
    // we widen with `unknown` first.
    activeIterator = iterator as unknown as AsyncIterator<IssueLabelAddedEvent["raw"]>;
    try {
      while (!stopped) {
        const next = await iterator.next();
        if (next.done) return;
        const event = next.value;
        if (event.kind !== "issue-label-added") {
          // Comment-created / status-changed are informational; the pickup
          // driver only cares about ready-label additions.
          logger?.debug("linear pickup ignored (not a label-add)", {
            kind: event.kind,
            webhookId: event.webhookId,
          });
          continue;
        }
        if (!opts.isReadyLabelId) {
          logger?.warn("linear pickup dropped (no isReadyLabelId predicate wired)", {
            issueId: event.issueId,
            readyLabel,
            addedLabelIds: event.addedLabelIds,
          });
          continue;
        }
        const hit = event.addedLabelIds.find((id) => opts.isReadyLabelId?.(id));
        if (hit === undefined) {
          logger?.debug("linear pickup ignored (no matching ready label id)", {
            issueId: event.issueId,
            addedLabelIds: event.addedLabelIds,
          });
          continue;
        }
        const runId = mint();
        try {
          opts.registry.bind(runId, event.issueId);
        } catch (cause) {
          // bind() throws TypeError on runId collision, which would only
          // happen if `mint()` returned a duplicate — effectively
          // impossible with ULID, but log and skip rather than crashing
          // the drain loop.
          logger?.error("linear pickup registry.bind threw", {
            issueId: event.issueId,
            runId,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
          continue;
        }
        const pickup: LinearPickup = {
          kind: "linear.pickup",
          issueId: event.issueId,
          runId,
          at: now(),
        };
        try {
          await opts.onPickup(pickup);
        } catch (cause) {
          // Losing one pickup is better than silencing all — log and keep
          // draining. The bound registry entry stays; a downstream retry
          // can pick up on the same issue by inspecting the registry.
          logger?.error("linear pickup onPickup threw", {
            issueId: event.issueId,
            runId,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    } finally {
      activeIterator = null;
    }
  }

  const done = drain();

  return {
    async stop(): Promise<void> {
      if (stopped) {
        // Still await `done` so callers can always chain on `.stop()`.
        await done.catch(() => undefined);
        return;
      }
      stopped = true;
      // If the drain loop is parked on an `await iterator.next()`, calling
      // `return()` on the iterator resolves that promise with
      // `{ done: true }` and unblocks the loop.
      const iter = activeIterator;
      if (iter && typeof iter.return === "function") {
        // `return()` may itself throw; swallow so stop() is idempotent.
        try {
          await iter.return(undefined);
        } catch {
          /* intentionally empty — stop() must not reject */
        }
      }
      await done.catch(() => undefined);
    },
    done,
  };
}
