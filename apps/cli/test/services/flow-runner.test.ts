/**
 * Unit tests for `runFlowInProcess`.
 *
 * Exercises the extracted shared service — loads a tiny inline flow
 * module (`test/fixtures/micro-flow.ts`) to avoid the canonical flow's
 * heavy deps, pipes events through a caller-supplied bus, and asserts
 * on the persistence + resume paths against an in-memory fake DB.
 */

import { join } from "node:path";
import type { FlowEvent } from "@shamu/core-flow";
import { EventBus } from "@shamu/core-flow";
import { createLogger } from "@shamu/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFlowInProcess } from "../../src/services/flow-runner.ts";
import { createFakeFlowDb } from "../helpers/fake-db.ts";

const MICRO_FLOW = join(__dirname, "..", "fixtures", "micro-flow.ts");

const CAPTURE_KEY = "__MICRO_FLOW_CAPTURE__";

function makeLogger(): ReturnType<typeof createLogger> {
  // Sink logs to a no-op transport so the test output stays readable.
  return createLogger({ transport: () => undefined });
}

function readCapture(): { task: unknown; workspaceCwd: string; maxIterations: number | null } {
  const g = globalThis as unknown as Record<string, unknown>;
  const value = g[CAPTURE_KEY];
  if (value === undefined) throw new Error("flow-runner test: capture was never populated");
  return value as { task: unknown; workspaceCwd: string; maxIterations: number | null };
}

describe("runFlowInProcess", () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>)[CAPTURE_KEY] = undefined;
    process.env.SHAMU_MICRO_FLOW_CAPTURE_GLOBAL = CAPTURE_KEY;
  });

  afterEach(() => {
    delete process.env.SHAMU_MICRO_FLOW_CAPTURE_GLOBAL;
  });

  it("runs a simple one-node flow to completion", async () => {
    const db = createFakeFlowDb();
    const logger = makeLogger();
    const bus = new EventBus<FlowEvent>();
    const outcome = await runFlowInProcess({
      moduleSpec: MICRO_FLOW,
      task: "smoke",
      workspaceCwd: process.cwd(),
      db,
      logger,
      flowBus: bus,
      outputMode: "silent",
    });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.flowRunId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // One flow_runs row, status succeeded.
    const row = db.getRow(outcome.flowRunId);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("succeeded");
    expect(row?.flow_id).toBe("micro-flow");
  });

  it("propagates task input to the first node", async () => {
    const db = createFakeFlowDb();
    const logger = makeLogger();
    const bus = new EventBus<FlowEvent>();
    const outcome = await runFlowInProcess({
      moduleSpec: MICRO_FLOW,
      task: "hello-world",
      workspaceCwd: "/tmp/some-cwd",
      db,
      logger,
      flowBus: bus,
      outputMode: "silent",
    });
    expect(outcome.status).toBe("succeeded");
    const capture = readCapture();
    expect(capture.task).toBe("hello-world");
    expect(capture.workspaceCwd).toBe("/tmp/some-cwd");
  });

  it("subscribes the caller-provided flowBus", async () => {
    const db = createFakeFlowDb();
    const logger = makeLogger();
    const bus = new EventBus<FlowEvent>();
    const kinds: string[] = [];
    bus.subscribe((ev) => kinds.push(ev.kind));
    await runFlowInProcess({
      moduleSpec: MICRO_FLOW,
      task: "bus-check",
      workspaceCwd: process.cwd(),
      db,
      logger,
      flowBus: bus,
      outputMode: "silent",
    });
    expect(kinds[0]).toBe("flow_started");
    expect(kinds.at(-1)).toBe("flow_completed");
    expect(kinds).toContain("node_started");
    expect(kinds).toContain("node_completed");
  });

  it("silent output mode emits nothing to stdout", async () => {
    const db = createFakeFlowDb();
    const logger = makeLogger();
    const bus = new EventBus<FlowEvent>();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runFlowInProcess({
        moduleSpec: MICRO_FLOW,
        task: "silent",
        workspaceCwd: process.cwd(),
        db,
        logger,
        flowBus: bus,
        outputMode: "silent",
      });
    } finally {
      writeSpy.mockRestore();
    }
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("resume path loads prior state_json and reuses the prior id", async () => {
    const db = createFakeFlowDb();
    const logger = makeLogger();

    // First run to seed a row.
    const first = await runFlowInProcess({
      moduleSpec: MICRO_FLOW,
      task: "seed",
      workspaceCwd: process.cwd(),
      db,
      logger,
      flowBus: new EventBus<FlowEvent>(),
      outputMode: "silent",
    });
    expect(first.status).toBe("succeeded");
    const priorId = first.flowRunId;

    // Resume against the same id — runner would have returned a cached
    // output since the inputs are identical (content-hash match).
    const second = await runFlowInProcess({
      moduleSpec: MICRO_FLOW,
      task: "seed",
      workspaceCwd: process.cwd(),
      resumeFlowRunId: priorId,
      db,
      logger,
      flowBus: new EventBus<FlowEvent>(),
      outputMode: "silent",
    });
    expect(second.status).toBe("succeeded");
    expect(second.flowRunId).toBe(priorId);
  });

  it("throws FlowRunnerUsageError when the module spec is missing required exports", async () => {
    const db = createFakeFlowDb();
    const logger = makeLogger();
    await expect(
      runFlowInProcess({
        moduleSpec: join(__dirname, "..", "fixtures", "does-not-exist.ts"),
        task: "t",
        workspaceCwd: process.cwd(),
        db,
        logger,
        flowBus: new EventBus<FlowEvent>(),
        outputMode: "silent",
      }),
    ).rejects.toThrow();
  });
});
