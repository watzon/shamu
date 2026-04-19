/**
 * Unit tests for the `CursorAdapter` shell: capability manifest wiring,
 * factory correctness, G8 runId invariant, spawn/resume wiring via the ACP
 * client. No real subprocess — every test injects a scripted driver.
 */

import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import {
  CURSOR_CAPABILITIES,
  CursorAdapter,
  type CursorDriver,
  createCursorAdapter,
} from "../src/index.ts";
import { makeFakeDriver } from "./harness.ts";

describe("CursorAdapter — capabilities", () => {
  it("declares the frozen manifest shape", () => {
    expect(CURSOR_CAPABILITIES.resume).toBe(true);
    expect(CURSOR_CAPABILITIES.fork).toBe(false);
    expect(CURSOR_CAPABILITIES.interrupt).toBe("cooperative");
    expect(CURSOR_CAPABILITIES.mcp).toBe("none");
    expect(CURSOR_CAPABILITIES.customTools).toBe(false);
    expect(CURSOR_CAPABILITIES.patchVisibility).toBe("events");
    expect(CURSOR_CAPABILITIES.usageReporting).toBe("per-turn");
    expect(CURSOR_CAPABILITIES.costReporting).toBe("subscription");
    expect(CURSOR_CAPABILITIES.sandboxing).toBe("process");
    expect(CURSOR_CAPABILITIES.streaming).toBe("events");
  });

  it("exposes a frozen capabilities reference (G8)", () => {
    expect(Object.isFrozen(CURSOR_CAPABILITIES)).toBe(true);
  });
});

describe("CursorAdapter — factory", () => {
  it("createCursorAdapter returns a CursorAdapter", () => {
    const adapter = createCursorAdapter();
    expect(adapter).toBeInstanceOf(CursorAdapter);
    expect(adapter.vendor).toBe("cursor");
    expect(adapter.capabilities).toBe(CURSOR_CAPABILITIES);
  });

  it("vendor override", () => {
    const adapter = new CursorAdapter({ vendor: "cursor-fork" });
    expect(adapter.vendor).toBe("cursor-fork");
  });
});

describe("CursorAdapter — spawn + resume", () => {
  it("spawn consumes opts.runId (G8 — does not mint its own)", async () => {
    const harness = makeFakeDriver();
    const adapter = new CursorAdapter({ driverFactory: async () => harness.driver });
    const runId = newRunId();
    const handle = await adapter.spawn({ runId, cwd: "/tmp/shamu-cursor-test" });
    expect(handle.runId).toBe(runId);
    await handle.shutdown("test");
    expect(harness.closed()).toBe(true);
  });

  it("spawn calls initialize then session/new", async () => {
    const harness = makeFakeDriver();
    const adapter = new CursorAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: "/tmp/shamu-cursor-test" });
    expect(harness.calls.map((c) => c.method)).toEqual(["initialize", "session/new"]);
    await handle.shutdown("t");
  });

  it("resume calls loadSession with the given sessionId", async () => {
    const harness = makeFakeDriver();
    const adapter = new CursorAdapter({ driverFactory: async () => harness.driver });
    const runId = newRunId();
    const sessionId = "sess-fake-1" as unknown as import("@shamu/shared/ids").SessionId;
    const handle = await adapter.resume(sessionId, {
      runId,
      cwd: "/tmp/shamu-cursor-test",
    });
    expect(handle.sessionId).toBe(sessionId);
    const load = harness.calls.find((c) => c.method === "session/load");
    expect(load).toBeDefined();
    await handle.shutdown("t");
  });

  it("rolls back the driver when session/new fails", async () => {
    const harness = makeFakeDriver({
      newSession: async () => {
        throw new Error("server down");
      },
    });
    const adapter = new CursorAdapter({ driverFactory: async () => harness.driver });
    await expect(
      adapter.spawn({ runId: newRunId(), cwd: "/tmp/shamu-cursor-test" }),
    ).rejects.toThrow(/server down/);
    expect(harness.closed()).toBe(true);
  });

  it("threads vendorOpts.apiKey through authenticate('cursor_login', …)", async () => {
    const harness = makeFakeDriver();
    const adapter = new CursorAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: "/tmp/shamu-cursor-test",
      vendorOpts: { apiKey: "sk-cursor-fixture-abc" },
    });
    const authCall = harness.calls.find((c) => c.method === "authenticate");
    expect(authCall).toBeDefined();
    expect(authCall?.args).toMatchObject({
      method: "cursor_login",
      params: { apiKey: "sk-cursor-fixture-abc" },
    });
    await handle.shutdown("t");
  });
});

describe("CursorAdapter — driverFactory injection", () => {
  it("calls the supplied driverFactory exactly once per spawn", async () => {
    let count = 0;
    let latest: CursorDriver | null = null;
    const adapter = new CursorAdapter({
      driverFactory: async () => {
        count += 1;
        latest = makeFakeDriver().driver;
        return latest;
      },
    });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: "/tmp/shamu-cursor-test" });
    expect(count).toBe(1);
    await handle.shutdown("t");
  });
});
