/**
 * Unit tests for the `OpencodeAdapter` shell: capability manifest wiring,
 * factory correctness, and the G8 runId invariant. No SDK or subprocess
 * work — these tests use the `driverFactory` injection point exclusively.
 */

import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import {
  createOpencodeAdapter,
  OPENCODE_CAPABILITIES,
  OpencodeAdapter,
  type OpencodeDriver,
  type OpencodeSdkClient,
} from "../src/index.ts";

/**
 * Minimal driver double: returns well-formed SDK responses for the REST
 * calls the adapter makes at spawn time (session.create/get) and stubs the
 * SSE stream to complete immediately so the handle finishes cleanly on
 * shutdown.
 */
function fakeDriver(): { driver: OpencodeDriver; closed: () => boolean } {
  let isClosed = false;
  const client: OpencodeSdkClient = {
    session: {
      async create() {
        return { data: { id: "sess-fake-1" } };
      },
      async get(args) {
        return { data: { id: args.path.id } };
      },
      async prompt() {
        return { data: {} };
      },
      async abort() {
        return { data: true };
      },
    },
    event: {
      async subscribe() {
        // Empty stream — completes immediately so the handle's background
        // consumer returns cleanly.
        return {
          stream: (async function* empty() {
            // generator body intentionally empty
          })(),
        };
      },
    },
    auth: {
      async set() {
        return { data: true };
      },
    },
  };
  return {
    driver: {
      client,
      async close() {
        isClosed = true;
      },
    },
    closed: () => isClosed,
  };
}

describe("OpencodeAdapter — capabilities", () => {
  it("declares the frozen manifest shape", () => {
    expect(OPENCODE_CAPABILITIES.resume).toBe(true);
    expect(OPENCODE_CAPABILITIES.fork).toBe(true);
    expect(OPENCODE_CAPABILITIES.interrupt).toBe("cooperative");
    expect(OPENCODE_CAPABILITIES.mcp).toBe("stdio");
    expect(OPENCODE_CAPABILITIES.customTools).toBe(true);
    expect(OPENCODE_CAPABILITIES.patchVisibility).toBe("events");
    expect(OPENCODE_CAPABILITIES.usageReporting).toBe("per-turn");
    expect(OPENCODE_CAPABILITIES.costReporting).toBe("subscription");
    expect(OPENCODE_CAPABILITIES.sandboxing).toBe("process");
    expect(OPENCODE_CAPABILITIES.streaming).toBe("events");
  });

  it("exposes a frozen capabilities reference (G8)", () => {
    expect(Object.isFrozen(OPENCODE_CAPABILITIES)).toBe(true);
  });
});

describe("OpencodeAdapter — factory", () => {
  it("createOpencodeAdapter returns an OpencodeAdapter", () => {
    const adapter = createOpencodeAdapter();
    expect(adapter).toBeInstanceOf(OpencodeAdapter);
    expect(adapter.vendor).toBe("opencode");
    expect(adapter.capabilities).toBe(OPENCODE_CAPABILITIES);
  });

  it("vendor can be overridden", () => {
    const adapter = new OpencodeAdapter({ vendor: "opencode-fork" });
    expect(adapter.vendor).toBe("opencode-fork");
  });
});

describe("OpencodeAdapter — spawn + resume", () => {
  it("spawn consumes opts.runId (G8 — does not mint its own)", async () => {
    const { driver } = fakeDriver();
    const adapter = new OpencodeAdapter({
      driverFactory: async () => driver,
    });
    const runId = newRunId();
    const handle = await adapter.spawn({
      runId,
      cwd: "/tmp/shamu-opencode-test-fake",
    });
    expect(handle.runId).toBe(runId);
    await handle.shutdown("test");
  });

  it("resume attaches to an existing sessionId", async () => {
    const { driver } = fakeDriver();
    const adapter = new OpencodeAdapter({
      driverFactory: async () => driver,
    });
    const runId = newRunId();
    // SessionId is a branded string; resume accepts the brand and the
    // vendor round-trips its id shape. Cast through unknown to supply a
    // hard-coded id the fake driver recognizes.
    const sessionId = "sess-fake-1" as unknown as import("@shamu/shared/ids").SessionId;
    const handle = await adapter.resume(sessionId, {
      runId,
      cwd: "/tmp/shamu-opencode-test-fake",
    });
    expect(handle.sessionId).toBe(sessionId);
    await handle.shutdown("test");
  });

  it("shutdown reaps the driver (closes owned server)", async () => {
    const { driver, closed } = fakeDriver();
    const adapter = new OpencodeAdapter({ driverFactory: async () => driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: "/tmp/shamu-opencode-test-fake",
    });
    await handle.shutdown("test");
    expect(closed()).toBe(true);
  });

  it("driver close is called even if spawn post-session logic throws", async () => {
    const { driver, closed } = fakeDriver();
    // Override session.create to throw — the adapter should still close the
    // driver so no subprocess leaks.
    driver.client.session.create = async () => {
      throw new Error("boom");
    };
    const adapter = new OpencodeAdapter({ driverFactory: async () => driver });
    await expect(
      adapter.spawn({ runId: newRunId(), cwd: "/tmp/shamu-opencode-test-fake" }),
    ).rejects.toThrow(/boom/);
    expect(closed()).toBe(true);
  });
});
