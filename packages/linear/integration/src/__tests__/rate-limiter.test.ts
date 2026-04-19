/**
 * Unit tests for `createRateLimiter`.
 *
 * The limiter is pure logic — no timers, no promises that depend on the
 * wall clock — so every scenario is exercised synchronously / with
 * microtask drains. `flushMicrotasks` is the one affordance: cascading
 * resolves (release → drain → resolve waiter) take two microtask cycles.
 */

import { describe, expect, it } from "vitest";
import { createRateLimiter, RateLimiterOverflowError } from "../rate-limiter.ts";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createRateLimiter", () => {
  it("tryAcquire respects globalCap", () => {
    const limiter = createRateLimiter({
      globalCap: 2,
      perRoleCap: { executor: 5 },
    });
    const a = limiter.tryAcquire("executor", "a");
    const b = limiter.tryAcquire("executor", "b");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(limiter.inFlight).toBe(2);
    const c = limiter.tryAcquire("executor", "c");
    expect(c).toBeNull();
  });

  it("tryAcquire respects per-role cap below global cap", () => {
    const limiter = createRateLimiter({
      globalCap: 5,
      perRoleCap: { planner: 1, executor: 2 },
    });
    const p1 = limiter.tryAcquire("planner", "p1");
    const p2 = limiter.tryAcquire("planner", "p2");
    expect(p1).not.toBeNull();
    expect(p2).toBeNull();
    // Executor has its own room.
    const e1 = limiter.tryAcquire("executor", "e1");
    const e2 = limiter.tryAcquire("executor", "e2");
    const e3 = limiter.tryAcquire("executor", "e3");
    expect(e1).not.toBeNull();
    expect(e2).not.toBeNull();
    expect(e3).toBeNull();
  });

  it("release decrements counters and wakes the next waiter", async () => {
    const limiter = createRateLimiter({
      globalCap: 1,
      perRoleCap: { executor: 1 },
    });
    const a = limiter.tryAcquire("executor", "a");
    expect(a).not.toBeNull();
    const parked = limiter.acquire("executor", "b");
    expect(limiter.queueLength).toBe(1);
    a?.release();
    await flushMicrotasks();
    const b = await parked;
    expect(b.id).toBe("b");
    expect(limiter.inFlight).toBe(1);
    expect(limiter.queueLength).toBe(0);
    b.release();
    expect(limiter.inFlight).toBe(0);
    expect(limiter.byRole.executor).toBe(0);
  });

  it("acquire resolves immediately when headroom exists", async () => {
    const limiter = createRateLimiter({
      globalCap: 2,
      perRoleCap: { executor: 2 },
    });
    const lease = await limiter.acquire("executor", "r1");
    expect(lease.id).toBe("r1");
    expect(lease.role).toBe("executor");
    expect(limiter.inFlight).toBe(1);
  });

  it("bounded queue overflow rejects with RateLimiterOverflowError", async () => {
    const limiter = createRateLimiter({
      globalCap: 1,
      perRoleCap: { executor: 1 },
      queueCapacity: 2,
    });
    const a = limiter.tryAcquire("executor", "a");
    expect(a).not.toBeNull();
    const waiter1 = limiter.acquire("executor", "w1");
    const waiter2 = limiter.acquire("executor", "w2");
    expect(limiter.queueLength).toBe(2);
    await expect(limiter.acquire("executor", "w3")).rejects.toBeInstanceOf(
      RateLimiterOverflowError,
    );
    // Unblock the chain so pending promises resolve before the test ends.
    a?.release();
    await flushMicrotasks();
    const w1 = await waiter1;
    w1.release();
    await flushMicrotasks();
    const w2 = await waiter2;
    w2.release();
  });

  it("tryAcquire never enqueues — it is non-blocking", () => {
    const limiter = createRateLimiter({
      globalCap: 1,
      perRoleCap: { executor: 1 },
      queueCapacity: 4,
    });
    const a = limiter.tryAcquire("executor", "a");
    expect(a).not.toBeNull();
    const b = limiter.tryAcquire("executor", "b");
    expect(b).toBeNull();
    expect(limiter.queueLength).toBe(0);
    a?.release();
  });

  it("AbortSignal cancels a parked waiter", async () => {
    const limiter = createRateLimiter({
      globalCap: 1,
      perRoleCap: { executor: 1 },
    });
    const a = limiter.tryAcquire("executor", "a");
    expect(a).not.toBeNull();
    const controller = new AbortController();
    const pending = limiter.acquire("executor", "b", controller.signal);
    expect(limiter.queueLength).toBe(1);
    controller.abort(new Error("nope"));
    await expect(pending).rejects.toThrow(/nope/);
    expect(limiter.queueLength).toBe(0);
    // Limiter still functional after the abort.
    a?.release();
    expect(limiter.inFlight).toBe(0);
  });

  it("AbortSignal already aborted rejects immediately without enqueueing", async () => {
    const limiter = createRateLimiter({
      globalCap: 1,
      perRoleCap: { executor: 1 },
    });
    const a = limiter.tryAcquire("executor", "a");
    expect(a).not.toBeNull();
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(limiter.acquire("executor", "b", signal)).rejects.toThrow(/cancelled/);
    expect(limiter.queueLength).toBe(0);
    a?.release();
  });

  it("release is idempotent", () => {
    const limiter = createRateLimiter({
      globalCap: 2,
      perRoleCap: { executor: 2 },
    });
    const lease = limiter.tryAcquire("executor", "a");
    expect(lease).not.toBeNull();
    if (!lease) return;
    lease.release();
    expect(limiter.inFlight).toBe(0);
    lease.release();
    expect(limiter.inFlight).toBe(0);
  });

  it("byRole reports live counts", () => {
    const limiter = createRateLimiter({
      globalCap: 3,
      perRoleCap: { planner: 1, executor: 2 },
    });
    const p = limiter.tryAcquire("planner", "p");
    const e1 = limiter.tryAcquire("executor", "e1");
    const e2 = limiter.tryAcquire("executor", "e2");
    expect(limiter.byRole.planner).toBe(1);
    expect(limiter.byRole.executor).toBe(2);
    e1?.release();
    expect(limiter.byRole.executor).toBe(1);
    e2?.release();
    expect(limiter.byRole.executor).toBe(0);
    p?.release();
    expect(limiter.byRole.planner).toBe(0);
  });

  it("release wakes waiters from a different role if only global was blocking", async () => {
    const limiter = createRateLimiter({
      globalCap: 2,
      perRoleCap: { planner: 1, executor: 1 },
    });
    const p = limiter.tryAcquire("planner", "p");
    const e = limiter.tryAcquire("executor", "e");
    expect(p).not.toBeNull();
    expect(e).not.toBeNull();
    // Both roles blocked on per-role + global. A NEW role would wait on
    // global only.
    const parked = limiter.acquire("reviewer", "r");
    expect(limiter.queueLength).toBe(1);
    p?.release();
    await flushMicrotasks();
    const r = await parked;
    expect(r.role).toBe("reviewer");
    r.release();
    e?.release();
  });

  it("rejects construction with non-positive globalCap", () => {
    expect(() =>
      createRateLimiter({
        globalCap: 0,
        perRoleCap: {},
      }),
    ).toThrow(TypeError);
    expect(() =>
      createRateLimiter({
        globalCap: -1,
        perRoleCap: {},
      }),
    ).toThrow(TypeError);
  });

  it("rejects construction with non-integer perRoleCap entries", () => {
    expect(() =>
      createRateLimiter({
        globalCap: 3,
        perRoleCap: { executor: 0 },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createRateLimiter({
        globalCap: 3,
        perRoleCap: { executor: 1.5 },
      }),
    ).toThrow(TypeError);
  });

  it("role missing from perRoleCap is bound only by globalCap", () => {
    const limiter = createRateLimiter({
      globalCap: 2,
      perRoleCap: { planner: 1 },
    });
    const a = limiter.tryAcquire("other", "a");
    const b = limiter.tryAcquire("other", "b");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const c = limiter.tryAcquire("other", "c");
    expect(c).toBeNull();
  });
});
