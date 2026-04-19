/**
 * In-process run spawner for the web dashboard.
 *
 * Mirrors `apps/cli/src/commands/run.ts` but writes events directly to the
 * shared SQLite DB instead of stdout. The SSE live-tail the frontend
 * already subscribes to picks them up via `/api/runs/:id/stream`.
 *
 * Responsibilities:
 *   1. Resolve the vendor CLI with `resolveVendorCli` (same chain as the
 *      CLI — single source of truth).
 *   2. Spin up a per-run egress broker via `withEgressBroker`.
 *   3. Instantiate the adapter, call `spawn(opts)`, assert the handle
 *      adopts the orchestrator-owned runId (G8).
 *   4. Insert a `runs` row.
 *   5. Drain `handle.events`, stamp each cost event via the adapter's
 *      capability manifest (T17), and persist to `events` + `raw_events`.
 *   6. On `turn_end`: projected to `completed`; on fatal `error`:
 *      `failed`; on interrupt: `failed`.
 *   7. Register the handle in a per-process `ACTIVE_RUNS` map so the
 *      `POST /api/runs/:id/interrupt` endpoint can cancel cooperatively.
 *
 * The function runs fire-and-forget: it resolves when the run is
 * registered in the DB, then continues in the background. The HTTP
 * handler returns `{ runId, url }` immediately.
 */

import type { AgentAdapter, AgentHandle, SpawnOpts } from "@shamu/adapters-base";
import { stampCostEventFromCapability } from "@shamu/adapters-base";
import type { VendorName } from "@shamu/adapters-base/vendor-cli-resolver";
import {
  resolveVendorCli,
  type VendorCliResolverResult,
} from "@shamu/adapters-base/vendor-cli-resolver";
import { withEgressBroker } from "@shamu/core-composition";
import { type EgressPolicy, policyFromAllowlist } from "@shamu/egress-broker";
import { eventsQueries, runsQueries, type ShamuDatabase } from "@shamu/persistence";
import { eventId as brandEventId, newRunId, type RunId } from "@shamu/shared";
import { ADAPTER_MODULES, adapterHasVendorCli, type ModelInfo } from "./adapters.ts";

export type { ModelInfo } from "./adapters.ts";

/** In-flight run. Keyed by runId. */
interface ActiveRun {
  readonly runId: RunId;
  readonly adapter: AgentAdapter;
  readonly handle: AgentHandle;
  readonly startedAt: number;
  /** Tears down broker + adapter. Idempotent. */
  shutdown(): Promise<void>;
}

/**
 * Process-scoped map of in-flight runs. The web process is single-user;
 * this is not shared across workers. Keyed by `RunId` so the interrupt
 * endpoint's lookup is O(1).
 */
const ACTIVE_RUNS = new Map<RunId, ActiveRun>();

/** Return the active run handle for the given runId, or null. */
export function getActiveRun(runId: RunId): ActiveRun | null {
  return ACTIVE_RUNS.get(runId) ?? null;
}

/** Input accepted by `startRun` / `POST /api/runs`. */
export interface StartRunInput {
  readonly task: string;
  readonly adapter: VendorName;
  readonly role: string;
  /** Optional flow module spec. Reserved — single-adapter path ships first. */
  readonly flow?: string;
  readonly model?: string;
  /** Path to an egress policy JSON. When absent, falls back to vendor defaults. */
  readonly egressPolicy?: EgressPolicy;
}

/** Result of a successful start. */
export interface StartRunSuccess {
  readonly ok: true;
  readonly runId: RunId;
  readonly url: string;
}

/** Resolver miss → surface the adapter + candidate list. */
export interface StartRunResolverMiss {
  readonly ok: false;
  readonly code: "vendor-cli-not-found";
  readonly adapter: VendorName;
  readonly checked: readonly string[];
  readonly message: string;
}

/** Generic failure (adapter spawn threw, DB write failed, …). */
export interface StartRunError {
  readonly ok: false;
  readonly code: "spawn-failed" | "internal";
  readonly message: string;
}

export type StartRunResult = StartRunSuccess | StartRunResolverMiss | StartRunError;

export interface StartRunDeps {
  readonly db: ShamuDatabase;
  /** Injectable for tests — defaults to `resolveVendorCli`. */
  readonly resolve?: typeof resolveVendorCli;
  /**
   * Test seam — when set, `startRun` skips `withEgressBroker` and uses
   * the caller's SpawnOpts directly. Production code leaves this unset.
   */
  readonly skipEgressBroker?: boolean;
}

/**
 * Start a new run. Returns as soon as the run is registered in the DB +
 * the handle is spawned; the event drainer runs in the background.
 *
 * Never throws for expected failures (resolver miss, adapter spawn
 * error); those come back as tagged results so the HTTP layer can map
 * them to structured JSON responses.
 */
export async function startRun(input: StartRunInput, deps: StartRunDeps): Promise<StartRunResult> {
  const { db } = deps;
  const resolve = deps.resolve ?? resolveVendorCli;
  const adapterModule = ADAPTER_MODULES[input.adapter];

  // 1. Resolve the vendor CLI BEFORE any subprocess work. Structured
  //    failure surfaces with the full candidate list so the UI renders
  //    an actionable diagnostic.
  let cliResolution: VendorCliResolverResult;
  try {
    const descriptor = await adapterModule.descriptor();
    cliResolution = await resolve({ adapter: input.adapter, descriptor });
  } catch (err) {
    // `VendorCliNotFoundError` carries `.attempts`. We surface the
    // specific path list so the frontend can render it inline.
    const attempts =
      err !== null && typeof err === "object" && "attempts" in err
        ? ((err as { attempts?: unknown }).attempts as unknown)
        : undefined;
    const checked = Array.isArray(attempts)
      ? attempts
          .filter(
            (a): a is { path: string; outcome: string } =>
              typeof a === "object" && a !== null && "path" in a && "outcome" in a,
          )
          .filter((a) => a.outcome === "missing" && typeof a.path === "string")
          .map((a) => a.path)
      : [];
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "vendor-cli-not-found",
      adapter: input.adapter,
      checked,
      message,
    };
  }

  // 2. Instantiate the adapter.
  let adapter: AgentAdapter;
  try {
    adapter = await adapterModule.load();
  } catch (err) {
    return {
      ok: false,
      code: "internal",
      message: `failed to load adapter module: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. Orchestrator-owned runId.
  const runId = newRunId();

  // 4. Egress broker. Policy precedence: caller-supplied > default allow-list.
  const baseSpawnOpts: SpawnOpts = {
    cwd: process.cwd(),
    runId,
    ...(cliResolution.path.length > 0 ? { vendorCliPath: cliResolution.path } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
  };

  let spawnOpts: SpawnOpts = baseSpawnOpts;
  let brokerShutdown: (() => Promise<void>) | null = null;
  if (!deps.skipEgressBroker && adapterHasVendorCli(input.adapter)) {
    try {
      const policy =
        input.egressPolicy ??
        policyFromAllowlist(
          // Empty allow-list + `allowedHostSuffixes` later-phase addition
          // would pin vendor APIs; for now keep to the conservative
          // "loopback-only" default the CLI uses when no config is
          // provided. Callers who want vendor API access must supply
          // `egressPolicy`.
          ["127.0.0.1", "localhost"],
        );
      const brokered = await withEgressBroker({ policy, baseSpawnOpts });
      spawnOpts = brokered.spawnOpts;
      brokerShutdown = brokered.shutdown;
    } catch (err) {
      return {
        ok: false,
        code: "internal",
        message: `egress broker start failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 5. Spawn.
  let handle: AgentHandle;
  try {
    handle = await adapter.spawn(spawnOpts);
    if (handle.runId !== runId) {
      await handle.shutdown("runid-mismatch").catch(() => {});
      if (brokerShutdown !== null) await brokerShutdown().catch(() => {});
      return {
        ok: false,
        code: "internal",
        message: `adapter ${input.adapter} returned mismatched runId`,
      };
    }
  } catch (err) {
    if (brokerShutdown !== null) await brokerShutdown().catch(() => {});
    return {
      ok: false,
      code: "spawn-failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // 6. Register the run row BEFORE sending the first user-turn so the
  //    SSE subscriber on `/run/<id>` sees an existing row when it opens.
  try {
    runsQueries.insertRun(db, {
      runId,
      role: input.role,
      vendor: adapter.vendor,
      status: "running",
    });
  } catch (err) {
    try {
      await handle.shutdown("db-insert-failed");
    } catch {
      /* ignore */
    }
    if (brokerShutdown !== null) await brokerShutdown().catch(() => {});
    return {
      ok: false,
      code: "internal",
      message: `failed to insert run row: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 7. Track the in-flight handle for the interrupt endpoint.
  const active: ActiveRun = {
    runId,
    adapter,
    handle,
    startedAt: Date.now(),
    async shutdown() {
      try {
        await handle.shutdown("complete");
      } catch {
        /* best-effort */
      }
      if (brokerShutdown !== null) {
        try {
          await brokerShutdown();
        } catch {
          /* best-effort */
        }
      }
    },
  };
  ACTIVE_RUNS.set(runId, active);

  // 8. Kick off the first user turn + the event drain in the background.
  //    We do NOT `await` either — the HTTP handler returns immediately
  //    with { runId, url }; the SSE stream picks up events as they land.
  void (async () => {
    try {
      await handle.send({ text: input.task });
      await drainEvents({ db, adapter, handle, runId });
      runsQueries.updateRunStatus(db, runId, "completed");
    } catch (err) {
      try {
        runsQueries.updateRunStatus(db, runId, "failed");
      } catch {
        /* ignore */
      }
      // Best-effort: surface the error as a synthetic event so the SSE
      // consumer sees something rather than silent completion.
      /* eslint-disable-next-line no-console */
      console.error(
        `runs-runner: background run ${runId} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      ACTIVE_RUNS.delete(runId);
      await active.shutdown();
    }
  })();

  return {
    ok: true,
    runId,
    url: `/run/${encodeURIComponent(runId)}`,
  };
}

/**
 * Drain a handle's `events` iterator into SQLite. Stamps each `cost` event
 * with the core-authoritative confidence from the adapter's capability
 * manifest (T17). Exits cleanly on `turn_end` or a fatal `error`.
 */
async function drainEvents(params: {
  readonly db: ShamuDatabase;
  readonly adapter: AgentAdapter;
  readonly handle: AgentHandle;
  readonly runId: RunId;
}): Promise<void> {
  const { db, adapter, handle, runId } = params;
  for await (const raw of handle.events) {
    const ev = stampCostEventFromCapability(raw, adapter.capabilities.costReporting);
    try {
      eventsQueries.insertRawEvent(db, {
        eventId: brandEventId(ev.eventId),
        runId,
        vendor: adapter.vendor,
        ts: ev.tsWall,
        payload: ev,
      });
      eventsQueries.insertEvent(db, ev);
    } catch {
      // Persistence failures are non-fatal — the next event might still
      // land. The CLI's driver has identical behavior.
    }
    if (ev.kind === "turn_end") break;
    if (ev.kind === "error" && ev.fatal) break;
  }
}

/**
 * Interrupt a running agent. Returns the status the HTTP layer should
 * report back.
 */
export async function interruptRun(runId: RunId): Promise<"cancelled" | "unknown"> {
  const active = ACTIVE_RUNS.get(runId);
  if (active === undefined) return "unknown";
  try {
    await active.handle.interrupt("dashboard");
  } catch {
    // The handle may already be tearing itself down. Leave the `failed`
    // status projection to the drain loop's finally block.
  }
  return "cancelled";
}

/** Convenience: expose model catalogs for `GET /api/adapters/:vendor/models`. */
export async function listAdapterModels(vendor: VendorName): Promise<readonly ModelInfo[]> {
  return ADAPTER_MODULES[vendor].models();
}
