/**
 * `createRateLimiter` — semaphore + bounded pending queue the Phase 8.A
 * Linear daemon uses to cap concurrent flow runs.
 *
 * # Shape
 *
 * Two caps: a `globalCap` (total tokens in flight) and a `perRoleCap` map
 * (tokens in flight per `role` key). Acquiring a token requires BOTH caps
 * to have headroom for the requested role. Releasing a token decrements
 * both counters and wakes the oldest eligible waiter.
 *
 * Callers opt into either a non-blocking `tryAcquire` (returns null if the
 * caps are saturated) or a blocking `acquire` (parks the caller on a
 * bounded FIFO pending queue until a token frees up or `signal` aborts).
 *
 * # Why semaphore + bounded queue (not a token bucket)
 *
 * Phase 8.A cares about concurrency, not throughput. A semaphore gives us:
 *
 *   - Exact, human-readable cap semantics (`globalCap=3` means "at most 3
 *     runs in flight").
 *   - Trivial per-role fairness by stacking a second semaphore on the role
 *     key.
 *   - A `queueLength` signal the daemon can surface in its NDJSON
 *     telemetry without extra plumbing.
 *
 * A token bucket would let us rate-limit fresh pickups independently of
 * completion; we don't need that (Linear already rate-limits webhook
 * delivery) and the daemon would have to implement queue draining on top
 * anyway. Keeping this a simple semaphore also makes the unit tests
 * deterministic — no wall-clock simulation required.
 *
 * # Overflow semantics
 *
 * The pending queue is bounded (`queueCapacity`, default 8). When BOTH
 * caps are saturated AND the queue is full, `acquire` rejects with
 * {@link RateLimiterOverflowError} immediately. The daemon reads the
 * error kind and flips the issue to `shamu:blocked` with a
 * "rate-limit: queue-full" reason — the webhook delivery is ack'd so
 * Linear does not retry the same event.
 *
 * `tryAcquire` is the non-blocking probe; it returns `null` when either
 * cap is saturated (without touching the queue) and only throws for
 * programmer-error inputs (negative caps, etc.).
 *
 * # Cancellation
 *
 * `acquire(role, id, signal)` integrates with an `AbortSignal`: aborting
 * the signal while parked removes the waiter from the queue and rejects
 * the returned promise with the signal's `reason` (or a synthetic
 * `AbortError` when `reason` is undefined). If the signal is already
 * aborted before `acquire` runs, the rejection is immediate — the
 * limiter never holds an already-cancelled caller.
 *
 * # Lease release semantics
 *
 * `TokenLease.release()` is idempotent. The first call decrements
 * counters + wakes a waiter; subsequent calls are no-ops. This matches
 * what the daemon needs: a `finally` block can call `release()` without
 * tracking whether the happy-path `release()` already ran.
 *
 * # Determinism test seam
 *
 * `now?: () => number` exists for deterministic tests that correlate
 * queue timestamps with other observations. The limiter itself does not
 * block on wall-clock; `now` is purely decorative and stamped on the
 * lease.
 */

/** Options for {@link createRateLimiter}. */
export interface RateLimiterOptions {
  /** Max tokens in flight across all roles. Must be `>= 1`. */
  readonly globalCap: number;
  /**
   * Per-role cap map. Keys are role names; values are positive integers.
   * An unknown role is clamped to `globalCap` (no per-role limit beyond
   * the global one). Roles not present here still count against the
   * global cap.
   */
  readonly perRoleCap: Readonly<Record<string, number>>;
  /**
   * Max pending waiters when both caps are saturated. Default `8`. Must
   * be `>= 0`. A zero capacity turns every over-cap `acquire` into an
   * immediate {@link RateLimiterOverflowError} (useful for tests that
   * want to exercise the reject path without the queue in the loop).
   */
  readonly queueCapacity?: number;
  /** Clock override. Defaults to `Date.now`. Not load-bearing. */
  readonly now?: () => number;
}

/** Token returned by a successful acquire. Release is idempotent. */
export interface TokenLease {
  readonly id: string;
  readonly role: string;
  readonly acquiredAt: number;
  /** Return the token. Safe to call more than once; second call is a no-op. */
  release(): void;
}

/** Handle surface for the rate limiter. */
export interface RateLimiter {
  /**
   * Try to acquire a token non-blockingly. Returns a lease on success,
   * `null` when either cap is saturated.
   */
  tryAcquire(role: string, id: string): TokenLease | null;
  /**
   * Acquire a token. Returns a lease on success; rejects with
   * {@link RateLimiterOverflowError} when both caps are saturated AND the
   * pending queue is already at `queueCapacity`. Rejects with the
   * signal's `reason` if `signal` aborts while parked.
   */
  acquire(role: string, id: string, signal?: AbortSignal): Promise<TokenLease>;
  /** Number of tokens currently checked out across all roles. */
  readonly inFlight: number;
  /** Per-role in-flight counters. Read-only snapshot. */
  readonly byRole: Readonly<Record<string, number>>;
  /** Number of waiters currently parked in the pending queue. */
  readonly queueLength: number;
}

/**
 * Thrown by `acquire` when every cap is saturated AND the bounded pending
 * queue is full. The daemon catches this to flip the issue to blocked and
 * ack the webhook delivery.
 */
export class RateLimiterOverflowError extends Error {
  constructor(
    public readonly role: string,
    public readonly id: string,
    public readonly inFlight: number,
    public readonly queueLength: number,
  ) {
    super(
      `rate-limit: queue-full (${inFlight} runs in flight, ${queueLength} queued; role=${role} id=${id})`,
    );
    this.name = "RateLimiterOverflowError";
  }
}

/** Synthetic `AbortError` — matches DOM `AbortError` shape for test assertions. */
function makeAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "rate-limiter: acquire aborted");
  err.name = "AbortError";
  return err;
}

interface PendingWaiter {
  readonly role: string;
  readonly id: string;
  readonly resolve: (lease: TokenLease) => void;
  readonly reject: (cause: unknown) => void;
  readonly onAbort?: () => void;
  readonly signal?: AbortSignal;
}

/**
 * Build a rate limiter. Options are validated eagerly — negative caps or
 * non-positive queue capacity throw `TypeError` so misconfiguration surfaces
 * at boot, not at first pickup.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  if (!Number.isInteger(opts.globalCap) || opts.globalCap < 1) {
    throw new TypeError(
      `rate-limiter: globalCap must be a positive integer; got ${opts.globalCap}`,
    );
  }
  for (const [role, cap] of Object.entries(opts.perRoleCap)) {
    if (!Number.isInteger(cap) || cap < 1) {
      throw new TypeError(
        `rate-limiter: perRoleCap[${role}] must be a positive integer; got ${cap}`,
      );
    }
  }
  const queueCapacity = opts.queueCapacity ?? 8;
  if (!Number.isInteger(queueCapacity) || queueCapacity < 0) {
    throw new TypeError(
      `rate-limiter: queueCapacity must be a non-negative integer; got ${queueCapacity}`,
    );
  }
  const now = opts.now ?? Date.now;

  const perRoleCap = new Map<string, number>();
  for (const [role, cap] of Object.entries(opts.perRoleCap)) perRoleCap.set(role, cap);

  const roleCounts = new Map<string, number>();
  let inFlight = 0;
  const pending: PendingWaiter[] = [];

  function roleCap(role: string): number {
    return perRoleCap.get(role) ?? opts.globalCap;
  }

  function roleCount(role: string): number {
    return roleCounts.get(role) ?? 0;
  }

  function hasHeadroom(role: string): boolean {
    return inFlight < opts.globalCap && roleCount(role) < roleCap(role);
  }

  function mintLease(role: string, id: string): TokenLease {
    inFlight += 1;
    roleCounts.set(role, roleCount(role) + 1);
    let released = false;
    const lease: TokenLease = {
      id,
      role,
      acquiredAt: now(),
      release(): void {
        if (released) return;
        released = true;
        inFlight -= 1;
        const next = roleCount(role) - 1;
        if (next <= 0) roleCounts.delete(role);
        else roleCounts.set(role, next);
        drainWaiters();
      },
    };
    return lease;
  }

  /**
   * Walk the pending queue from the head; wake the first waiter whose
   * role still has headroom. Repeat until no eligible waiter remains —
   * a single `release()` can free multiple waiters if different roles
   * are involved.
   */
  function drainWaiters(): void {
    // Loop rather than single-shot: releasing a `planner` token can let a
    // parked `executor` proceed if headroom was blocked only by the global
    // cap.
    while (pending.length > 0 && inFlight < opts.globalCap) {
      const idx = pending.findIndex((w) => hasHeadroom(w.role));
      if (idx === -1) return;
      const waiter = pending.splice(idx, 1)[0];
      if (!waiter) return;
      if (waiter.onAbort && waiter.signal) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      const lease = mintLease(waiter.role, waiter.id);
      waiter.resolve(lease);
    }
  }

  const byRole = new Proxy<Record<string, number>>(
    {},
    {
      get(_t, p): number | undefined {
        if (typeof p !== "string") return undefined;
        return roleCount(p);
      },
      ownKeys(): string[] {
        return Array.from(roleCounts.keys());
      },
      getOwnPropertyDescriptor(_t, p): PropertyDescriptor | undefined {
        if (typeof p !== "string") return undefined;
        if (!roleCounts.has(p)) return undefined;
        return {
          enumerable: true,
          configurable: true,
          value: roleCount(p),
        };
      },
    },
  );

  return {
    tryAcquire(role: string, id: string): TokenLease | null {
      if (!hasHeadroom(role)) return null;
      return mintLease(role, id);
    },
    acquire(role: string, id: string, signal?: AbortSignal): Promise<TokenLease> {
      if (signal?.aborted) {
        return Promise.reject(makeAbortError(signal.reason));
      }
      if (hasHeadroom(role)) {
        return Promise.resolve(mintLease(role, id));
      }
      if (pending.length >= queueCapacity) {
        return Promise.reject(new RateLimiterOverflowError(role, id, inFlight, pending.length));
      }
      return new Promise<TokenLease>((resolve, reject) => {
        const waiter: PendingWaiter = signal
          ? {
              role,
              id,
              resolve,
              reject,
              signal,
              onAbort: (): void => {
                const idx = pending.indexOf(waiter);
                if (idx !== -1) pending.splice(idx, 1);
                reject(makeAbortError(signal.reason));
              },
            }
          : { role, id, resolve, reject };
        pending.push(waiter);
        if (waiter.onAbort && waiter.signal) {
          waiter.signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
      });
    },
    get inFlight(): number {
      return inFlight;
    },
    get byRole(): Readonly<Record<string, number>> {
      return byRole;
    },
    get queueLength(): number {
      return pending.length;
    },
  };
}
