/**
 * CI-tripwire observer — bridges the `@shamu/core-flow` event bus into a
 * `CiTripwire`'s `observe()` method.
 *
 * PLAN.md § "Core architecture → 6 Watchdog" + § "10 Quality gate":
 * the per-role CI-failure counter lives in `@shamu/watchdog` as a
 * producer (`CiTripwire`); the canonical plan-execute-ci-review flow
 * publishes `NodeCompleted` events whose `output.value` is a `CINodeOutput`
 * for the CI node. Neither package should import the other — the flow
 * shouldn't know about the watchdog's tripwire shape, and the watchdog
 * shouldn't know about the flow event bus. This module is the
 * composition-layer shim that listens on the flow bus and drives the
 * tripwire, keeping both sides decoupled.
 *
 * Shape discipline:
 *   - We do NOT import `CINodeOutput` from `@shamu/flows-plan-execute-review`
 *     — that would invert the layering (composition is below flows).
 *     Instead we guard `NodeOutput.value` with a minimal local
 *     structural check covering just the fields the tripwire reads:
 *     `summary.status` (`"green" | "red" | "unknown"`) and `runId`
 *     (string). If the shape is wrong, we log and return — never throw
 *     through the event bus (doing so would break sibling listeners).
 *   - `status` maps verbatim: `CINodeOutput.summary.status` is a strict
 *     subset of `CiTripwireObservation.status`.
 *
 * Stop semantics: `stop()` both calls the bus disposer AND flips an
 * internal flag. The flag is defense in depth — if a publish is already
 * in flight when `stop()` runs, the already-scheduled listener callback
 * will see the flag and bail before calling `tripwire.observe`.
 */

import type { EventBus } from "@shamu/core-flow/bus";
import type { FlowEvent, NodeCompleted } from "@shamu/core-flow/events";
import type { RunId } from "@shamu/shared/ids";
import type { CiTripwire } from "@shamu/watchdog";

/** Options for {@link createCiTripwireObserver}. */
export interface CiTripwireObserverOptions {
  readonly tripwire: CiTripwire;
  readonly flowBus: EventBus<FlowEvent>;
  /** The flow node id whose `CINodeOutput` drives the tripwire. */
  readonly ciNodeId: string;
  /** Role this tripwire is scoped to (e.g. "executor"). Defaults to "executor". */
  readonly role?: string;
  /** Optional clock override for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Handle returned by {@link createCiTripwireObserver}. */
export interface CiTripwireObserverHandle {
  /** Unsubscribe from the flow bus. Idempotent. */
  stop(): void;
}

/**
 * Minimum structural shape of a CI-node `NodeOutput.value`. Matches the
 * subset of `CINodeOutput` (from `@shamu/flows-plan-execute-review`) that
 * the tripwire needs. Kept module-private so `index.ts` does not leak
 * flow-package-shaped types into the public surface.
 */
interface CiOutputShape {
  readonly summary: { readonly status: "green" | "red" | "unknown" };
  readonly runId: string;
}

function isCiNodeOutputShape(value: unknown): value is CiOutputShape {
  if (value === null || typeof value !== "object") return false;
  const obj = value as { summary?: unknown; runId?: unknown };
  if (typeof obj.runId !== "string") return false;
  const summary = obj.summary;
  if (summary === null || typeof summary !== "object") return false;
  const status = (summary as { status?: unknown }).status;
  return status === "green" || status === "red" || status === "unknown";
}

export function createCiTripwireObserver(
  opts: CiTripwireObserverOptions,
): CiTripwireObserverHandle {
  const { tripwire, flowBus, ciNodeId } = opts;
  const role = opts.role ?? "executor";
  let stopped = false;

  const dispose = flowBus.subscribe((event: FlowEvent) => {
    if (stopped) return;
    if (event.kind !== "node_completed") return;
    const completed: NodeCompleted = event;
    if (completed.nodeId !== ciNodeId) return;

    const value = completed.output.value;
    if (!isCiNodeOutputShape(value)) {
      // Biome allows console.error explicitly; matches the EventBus
      // listener-error convention so a grep over sinks turns up one
      // place.
      console.error("[ci-tripwire-observer] unexpected CI node output", {
        nodeId: completed.nodeId,
        flowRunId: completed.flowRunId,
        value,
      });
      return;
    }

    tripwire.observe({
      role,
      status: value.summary.status,
      runId: value.runId as RunId,
      at: completed.at,
      detail: { nodeId: completed.nodeId, flowRunId: completed.flowRunId },
    });
  });

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      dispose();
    },
  };
}
