/**
 * Unit tests for `createCiTripwireObserver`.
 *
 * Scope: the observer is a pure bridge — flow-bus `NodeCompleted` events
 * for a specific `ciNodeId` are translated to `CiTripwireObservation`
 * calls on the injected `CiTripwire`. We assert: filter discipline
 * (kind + nodeId), status pass-through, role defaulting, malformed-shape
 * resilience, and idempotent `stop()`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { EventBus } from "@shamu/core-flow/bus";
import type { FlowEvent, NodeCompleted } from "@shamu/core-flow/events";
import { nodeId as makeNodeId } from "@shamu/core-flow/types";
import type { RunId, WorkflowRunId } from "@shamu/shared/ids";
import type { CiTripwire, CiTripwireObservation } from "@shamu/watchdog";
import { createCiTripwireObserver } from "../src/ci-tripwire-observer.ts";

interface FakeTripwire extends CiTripwire {
  readonly calls: CiTripwireObservation[];
}

function makeFakeTripwire(): FakeTripwire {
  const calls: CiTripwireObservation[] = [];
  return {
    calls,
    observe(input: CiTripwireObservation): void {
      calls.push(input);
    },
    reset(): void {
      // not used in these tests
    },
    snapshot() {
      return Object.freeze({});
    },
  };
}

const FLOW_RUN = "01HZXFLOW00000000000000FL01" as WorkflowRunId;
const RUN_A = "01HZXRUN0000000000000000AA" as RunId;

function makeNodeCompleted(overrides: {
  nodeId: string;
  value: unknown;
  at?: number;
}): NodeCompleted {
  return {
    kind: "node_completed",
    flowRunId: FLOW_RUN,
    nodeId: makeNodeId(overrides.nodeId),
    at: overrides.at ?? 1_700_000_000_000,
    durationMs: 1_000,
    output: {
      ok: true,
      value: overrides.value,
      costUsd: null,
      costConfidence: "unknown",
      costSource: "test",
    },
    cached: false,
  };
}

describe("createCiTripwireObserver", () => {
  const originalConsoleError = console.error;
  const logged: unknown[][] = [];

  beforeEach(() => {
    logged.length = 0;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it("subscribes on creation and stop() unsubscribes from the flow bus", () => {
    const bus = new EventBus<FlowEvent>();
    const tripwire = makeFakeTripwire();
    expect(bus.size).toBe(0);

    const handle = createCiTripwireObserver({
      tripwire,
      flowBus: bus,
      ciNodeId: "ci",
    });
    expect(bus.size).toBe(1);

    handle.stop();
    expect(bus.size).toBe(0);
  });

  it("ignores NodeCompleted events for a different nodeId", () => {
    const bus = new EventBus<FlowEvent>();
    const tripwire = makeFakeTripwire();
    createCiTripwireObserver({ tripwire, flowBus: bus, ciNodeId: "ci" });

    bus.publish(
      makeNodeCompleted({
        nodeId: "plan",
        value: { kind: "PatchReady", runId: RUN_A, summary: { status: "green" } },
      }),
    );

    expect(tripwire.calls).toHaveLength(0);
  });

  it("ignores non-node_completed events", () => {
    const bus = new EventBus<FlowEvent>();
    const tripwire = makeFakeTripwire();
    createCiTripwireObserver({ tripwire, flowBus: bus, ciNodeId: "ci" });

    bus.publish({
      kind: "node_started",
      flowRunId: FLOW_RUN,
      nodeId: makeNodeId("ci"),
      at: 1_700_000_000_000,
      attempt: 1,
    });
    bus.publish({
      kind: "flow_started",
      flowRunId: FLOW_RUN,
      flowId: "plan-execute-review",
      version: 2,
      at: 1_700_000_000_000,
      resumedFrom: null,
    });

    expect(tripwire.calls).toHaveLength(0);
  });

  it("maps status green / red / unknown through verbatim", () => {
    const bus = new EventBus<FlowEvent>();
    const tripwire = makeFakeTripwire();
    createCiTripwireObserver({ tripwire, flowBus: bus, ciNodeId: "ci" });

    for (const status of ["green", "red", "unknown"] as const) {
      bus.publish(
        makeNodeCompleted({
          nodeId: "ci",
          value: { kind: "PatchReady", runId: RUN_A, summary: { status } },
          at: 1_000,
        }),
      );
    }

    expect(tripwire.calls.map((c) => c.status)).toEqual(["green", "red", "unknown"]);
  });

  it("passes the runId and flow metadata through to CiTripwireObservation", () => {
    const bus = new EventBus<FlowEvent>();
    const tripwire = makeFakeTripwire();
    createCiTripwireObserver({ tripwire, flowBus: bus, ciNodeId: "ci" });

    bus.publish(
      makeNodeCompleted({
        nodeId: "ci",
        value: { kind: "CIRed", runId: RUN_A, summary: { status: "red" } },
        at: 42_000,
      }),
    );

    expect(tripwire.calls).toHaveLength(1);
    const call = tripwire.calls[0];
    if (!call) throw new Error("Expected a tripwire.observe call");
    expect(call.runId).toBe(RUN_A);
    expect(call.status).toBe("red");
    expect(call.at).toBe(42_000);
    expect(call.detail).toEqual({ nodeId: makeNodeId("ci"), flowRunId: FLOW_RUN });
  });

  it("defaults role to 'executor' when none is provided", () => {
    const bus = new EventBus<FlowEvent>();
    const tripwire = makeFakeTripwire();
    createCiTripwireObserver({ tripwire, flowBus: bus, ciNodeId: "ci" });

    bus.publish(
      makeNodeCompleted({
        nodeId: "ci",
        value: { kind: "PatchReady", runId: RUN_A, summary: { status: "green" } },
      }),
    );

    expect(tripwire.calls[0]?.role).toBe("executor");
  });

  it("passes a custom role through verbatim", () => {
    const bus = new EventBus<FlowEvent>();
    const tripwire = makeFakeTripwire();
    createCiTripwireObserver({
      tripwire,
      flowBus: bus,
      ciNodeId: "ci",
      role: "reviewer",
    });

    bus.publish(
      makeNodeCompleted({
        nodeId: "ci",
        value: { kind: "CIRed", runId: RUN_A, summary: { status: "red" } },
      }),
    );

    expect(tripwire.calls[0]?.role).toBe("reviewer");
  });

  it("gracefully handles malformed output.value — does not throw, does not call observe", () => {
    const bus = new EventBus<FlowEvent>();
    const tripwire = makeFakeTripwire();
    createCiTripwireObserver({ tripwire, flowBus: bus, ciNodeId: "ci" });

    const malformedShapes: unknown[] = [
      42,
      "ci-output",
      null,
      { runId: RUN_A }, // missing summary
      { summary: { status: "green" } }, // missing runId
      { runId: 123, summary: { status: "red" } }, // wrong runId type
      { runId: RUN_A, summary: { status: "maybe" } }, // wrong status
      { runId: RUN_A, summary: null },
    ];

    for (const value of malformedShapes) {
      expect(() => bus.publish(makeNodeCompleted({ nodeId: "ci", value }))).not.toThrow();
    }

    expect(tripwire.calls).toHaveLength(0);
    // We don't assert a specific log-count; we only assert the malformed
    // shapes surfaced at least one diagnostic (shape resilience is the
    // contract, not log cardinality).
    expect(logged.length).toBeGreaterThan(0);
  });

  it("stop() is idempotent", () => {
    const bus = new EventBus<FlowEvent>();
    const tripwire = makeFakeTripwire();
    const handle = createCiTripwireObserver({
      tripwire,
      flowBus: bus,
      ciNodeId: "ci",
    });

    handle.stop();
    expect(() => handle.stop()).not.toThrow();
    expect(bus.size).toBe(0);

    // Post-stop publishes do not land on the tripwire either.
    bus.publish(
      makeNodeCompleted({
        nodeId: "ci",
        value: { kind: "PatchReady", runId: RUN_A, summary: { status: "green" } },
      }),
    );
    expect(tripwire.calls).toHaveLength(0);
  });
});
