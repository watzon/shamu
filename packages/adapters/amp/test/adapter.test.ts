/**
 * Unit tests for the `AmpAdapter` shell: capability manifest wiring,
 * factory correctness, spawn + resume wiring, the G8 runId invariant,
 * and spawn rollback. No subprocess work — these tests use the
 * `driverFactory` injection point exclusively.
 */

import type { SessionId } from "@shamu/shared/ids";
import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import {
  AMP_CAPABILITIES,
  AmpAdapter,
  type AmpDriver,
  type AmpDriverOptions,
  createAmpAdapter,
} from "../src/index.ts";
import { makeFakeDriver } from "./harness.ts";

function factoryWith(
  opts: {
    readonly lastDriverOpts?: AmpDriverOptions[];
    readonly onMake?: (driver: AmpDriver) => void;
  } = {},
): (o: AmpDriverOptions) => Promise<AmpDriver> {
  return async (o) => {
    if (opts.lastDriverOpts) opts.lastDriverOpts.push(o);
    const h = makeFakeDriver();
    opts.onMake?.(h.driver);
    return h.driver;
  };
}

describe("AmpAdapter — capabilities", () => {
  it("declares the frozen manifest shape", () => {
    expect(AMP_CAPABILITIES.resume).toBe(true);
    expect(AMP_CAPABILITIES.fork).toBe(false);
    expect(AMP_CAPABILITIES.interrupt).toBe("cooperative");
    expect(AMP_CAPABILITIES.permissionModes).toEqual(["default"]);
    expect(AMP_CAPABILITIES.mcp).toBe("none");
    expect(AMP_CAPABILITIES.customTools).toBe(false);
    expect(AMP_CAPABILITIES.patchVisibility).toBe("events");
    expect(AMP_CAPABILITIES.usageReporting).toBe("per-turn");
    expect(AMP_CAPABILITIES.costReporting).toBe("subscription");
    expect(AMP_CAPABILITIES.sandboxing).toBe("process");
    expect(AMP_CAPABILITIES.streaming).toBe("events");
  });

  it("exposes a frozen capabilities reference (G8)", () => {
    expect(Object.isFrozen(AMP_CAPABILITIES)).toBe(true);
  });
});

describe("AmpAdapter — factory", () => {
  it("createAmpAdapter returns an AmpAdapter", () => {
    const adapter = createAmpAdapter();
    expect(adapter).toBeInstanceOf(AmpAdapter);
    expect(adapter.vendor).toBe("amp");
    expect(adapter.capabilities).toBe(AMP_CAPABILITIES);
  });

  it("vendor can be overridden", () => {
    const adapter = new AmpAdapter({ vendor: "amp-staging" });
    expect(adapter.vendor).toBe("amp-staging");
  });
});

describe("AmpAdapter — spawn + resume", () => {
  it("spawn consumes opts.runId (G8 — does not mint its own)", async () => {
    const adapter = new AmpAdapter({ driverFactory: factoryWith() });
    const runId = newRunId();
    const handle = await adapter.spawn({ runId, cwd: "/tmp/shamu-amp-fake" });
    expect(handle.runId).toBe(runId);
    await handle.shutdown("test");
  });

  it("spawn does NOT pass resumeThreadId to the driver", async () => {
    const captured: AmpDriverOptions[] = [];
    const adapter = new AmpAdapter({
      driverFactory: factoryWith({ lastDriverOpts: captured }),
    });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: "/tmp/shamu-amp-fake" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.resumeThreadId).toBeUndefined();
    await handle.shutdown("test");
  });

  it("resume passes the sessionId to the driver as resumeThreadId", async () => {
    const captured: AmpDriverOptions[] = [];
    const adapter = new AmpAdapter({
      driverFactory: factoryWith({ lastDriverOpts: captured }),
    });
    const sessionId = "thread-abc-123" as unknown as SessionId;
    const handle = await adapter.resume(sessionId, {
      runId: newRunId(),
      cwd: "/tmp/shamu-amp-fake",
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.resumeThreadId).toBe("thread-abc-123");
    expect(handle.sessionId).toBe(sessionId);
    await handle.shutdown("test");
  });

  it("forwards vendorCliPath to driver opts", async () => {
    const captured: AmpDriverOptions[] = [];
    const adapter = new AmpAdapter({
      driverFactory: factoryWith({ lastDriverOpts: captured }),
    });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: "/tmp/shamu-amp-fake",
      vendorCliPath: "/opt/shamu/amp-custom",
    });
    expect(captured[0]?.vendorCliPath).toBe("/opt/shamu/amp-custom");
    await handle.shutdown("test");
  });

  it("forwards vendorOpts.apiKey through auth resolution to driver apiKey", async () => {
    const captured: AmpDriverOptions[] = [];
    const adapter = new AmpAdapter({
      driverFactory: factoryWith({ lastDriverOpts: captured }),
    });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: "/tmp/shamu-amp-fake",
      vendorOpts: { apiKey: "amp_live_SECRET" },
    });
    expect(captured[0]?.apiKey).toBe("amp_live_SECRET");
    await handle.shutdown("test");
  });

  it("closes driver on spawn-post failure (rollback)", async () => {
    // Force the handle constructor to throw by supplying a handle-time
    // factory that deliberately triggers failure. We do this by overriding
    // the driver factory to return a driver with a broken `readLines` that
    // throws synchronously — but since the handle reads lazily, instead we
    // simulate a failure by throwing from the driverFactory itself.
    let closedByAdapter = false;
    const adapter = new AmpAdapter({
      driverFactory: async () => {
        const h = makeFakeDriver();
        // Wrap close to record adapter-initiated close.
        const originalClose = h.driver.close;
        (h.driver as { close: () => Promise<void> }).close = async () => {
          closedByAdapter = true;
          await originalClose();
        };
        // Return the driver AND throw from the next step by passing a
        // bogus runId via opts-invalid? The handle constructor throws when
        // runId is missing; we can't suppress that before spawn.
        return h.driver;
      },
    });
    // Force handle-constructor failure by passing an empty runId: G8
    // invariant throws.
    await expect(
      adapter.spawn({
        runId: "" as unknown as ReturnType<typeof newRunId>,
        cwd: "/tmp/shamu-amp-fake",
      }),
    ).rejects.toThrow();
    expect(closedByAdapter).toBe(true);
  });
});
