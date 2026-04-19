/**
 * Unit tests for the `GeminiAdapter` shell: capability manifest wiring,
 * factory correctness, G8 runId invariant, spawn/resume wiring via the ACP
 * client. No real subprocess — every test injects a scripted driver.
 */

import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import {
  createGeminiAdapter,
  GEMINI_CAPABILITIES,
  GeminiAdapter,
  type GeminiDriver,
} from "../src/index.ts";
import { makeFakeDriver } from "./harness.ts";

describe("GeminiAdapter — capabilities", () => {
  it("declares the frozen manifest shape", () => {
    expect(GEMINI_CAPABILITIES.resume).toBe(true);
    expect(GEMINI_CAPABILITIES.fork).toBe(false);
    expect(GEMINI_CAPABILITIES.interrupt).toBe("cooperative");
    expect(GEMINI_CAPABILITIES.mcp).toBe("none");
    expect(GEMINI_CAPABILITIES.customTools).toBe(false);
    expect(GEMINI_CAPABILITIES.patchVisibility).toBe("events");
    expect(GEMINI_CAPABILITIES.usageReporting).toBe("per-turn");
    expect(GEMINI_CAPABILITIES.costReporting).toBe("subscription");
    expect(GEMINI_CAPABILITIES.sandboxing).toBe("process");
    expect(GEMINI_CAPABILITIES.streaming).toBe("events");
  });

  it("exposes a frozen capabilities reference (G8)", () => {
    expect(Object.isFrozen(GEMINI_CAPABILITIES)).toBe(true);
  });
});

describe("GeminiAdapter — factory", () => {
  it("createGeminiAdapter returns a GeminiAdapter", () => {
    const adapter = createGeminiAdapter();
    expect(adapter).toBeInstanceOf(GeminiAdapter);
    expect(adapter.vendor).toBe("gemini");
    expect(adapter.capabilities).toBe(GEMINI_CAPABILITIES);
  });

  it("vendor override", () => {
    const adapter = new GeminiAdapter({ vendor: "gemini-fork" });
    expect(adapter.vendor).toBe("gemini-fork");
  });
});

describe("GeminiAdapter — spawn + resume", () => {
  it("spawn consumes opts.runId (G8 — does not mint its own)", async () => {
    const harness = makeFakeDriver();
    const adapter = new GeminiAdapter({ driverFactory: async () => harness.driver });
    const runId = newRunId();
    const handle = await adapter.spawn({ runId, cwd: "/tmp/shamu-gemini-test" });
    expect(handle.runId).toBe(runId);
    await handle.shutdown("test");
    expect(harness.closed()).toBe(true);
  });

  it("spawn calls initialize then session/new", async () => {
    const harness = makeFakeDriver();
    const adapter = new GeminiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: "/tmp/shamu-gemini-test" });
    expect(harness.calls.map((c) => c.method)).toEqual(["initialize", "session/new"]);
    await handle.shutdown("t");
  });

  it("resume calls loadSession with the given sessionId", async () => {
    const harness = makeFakeDriver();
    const adapter = new GeminiAdapter({ driverFactory: async () => harness.driver });
    const runId = newRunId();
    const sessionId = "sess-fake-1" as unknown as import("@shamu/shared/ids").SessionId;
    const handle = await adapter.resume(sessionId, {
      runId,
      cwd: "/tmp/shamu-gemini-test",
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
    const adapter = new GeminiAdapter({ driverFactory: async () => harness.driver });
    await expect(
      adapter.spawn({ runId: newRunId(), cwd: "/tmp/shamu-gemini-test" }),
    ).rejects.toThrow(/server down/);
    expect(harness.closed()).toBe(true);
  });

  it("threads vendorOpts.apiKey through authenticate('authenticate', { apiKey })", async () => {
    const harness = makeFakeDriver();
    const adapter = new GeminiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: "/tmp/shamu-gemini-test",
      vendorOpts: { apiKey: "gapi-fixture-xyz" },
    });
    const authCall = harness.calls.find((c) => c.method === "authenticate");
    expect(authCall).toBeDefined();
    expect(authCall?.args).toMatchObject({
      method: "authenticate",
      params: { apiKey: "gapi-fixture-xyz" },
    });
    await handle.shutdown("t");
  });
});

describe("GeminiAdapter — driverFactory injection", () => {
  it("calls the supplied driverFactory exactly once per spawn", async () => {
    let count = 0;
    let latest: GeminiDriver | null = null;
    const adapter = new GeminiAdapter({
      driverFactory: async () => {
        count += 1;
        latest = makeFakeDriver().driver;
        return latest;
      },
    });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: "/tmp/shamu-gemini-test" });
    expect(count).toBe(1);
    await handle.shutdown("t");
  });
});
