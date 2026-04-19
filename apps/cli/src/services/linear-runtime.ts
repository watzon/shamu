/**
 * Linear daemon runtime — composition root for `shamu linear serve`.
 *
 * Phase 8.A evolution (from the 6.C.3 MVP):
 *
 *  - Per-pickup runs execute CONCURRENTLY under a {@link RateLimiter}.
 *    Global cap (default 3) + per-role cap (planner=1, executor=2,
 *    reviewer=1) gate pickups; an overflow past the bounded pending
 *    queue flips the issue to `shamu:blocked`.
 *  - Graceful drain: `pause()` stops pickup intake; in-flight runs
 *    finish. `drainAndStop(deadlineMs)` cancels still-running flows and
 *    flips their issues to blocked before the process exits.
 *  - Per-run egress broker: {@link withEgressBroker} spins up a
 *    policy-enforcing loopback proxy for each pickup; denied hosts route
 *    into the supervisor bus as `escalation_raised` events so the
 *    existing escalation sink flips the issue to blocked (reason +
 *    incident comment).
 *  - Flow-shim prune on boot + every 50th pickup.
 *
 * Layering: the composition lives in `apps/cli/` per Phase 6.C.2. The
 * `@shamu/linear-integration` package remains primitive-only; this file
 * is where wiring happens.
 *
 * ## Concurrency model
 *
 *   - The pickup driver iterates webhook events serially (one fetch at
 *     a time). For each pickup we acquire a rate-limiter token; on
 *     success we spawn the handler on a detached promise and loop for
 *     the next event immediately. On overflow we flip the issue to
 *     `shamu:blocked` inside the pickup driver and do NOT spawn a
 *     handler. The driver's own back-pressure contract (Linear replay
 *     if we never ack) is unchanged — we still ack every pickup.
 *
 *   - In-flight run handles are tracked in a map keyed by `runId` so
 *     `drainAndStop` can enumerate and cancel them. The map entry
 *     carries the run's `AbortController` + its own promise + its
 *     `issueId`.
 *
 *   - `runtime.pause()` flips a boolean; the pickup driver's `onPickup`
 *     sees it and acks without enqueueing. No in-flight cancellation.
 *
 *   - `runtime.drainAndStop(deadlineMs)` awaits in-flight runs for up
 *     to `deadlineMs`; then triggers every run's AbortController and
 *     flips its issue to `shamu:blocked` with a
 *     "shutdown: drained before completion" reason.
 *
 * ## Egress broker
 *
 *   - On each pickup, we call {@link withEgressBroker} to start a
 *     per-run broker and get a {@link SpawnOpts} with the proxy env
 *     merged. The broker's `onEvent("denied", ev)` handler publishes a
 *     synthetic `escalation_raised` with `cause: "policy_violation"`
 *     on the supervisor bus — the existing escalation sink already
 *     handles that variant.
 *
 *   - The canonical flow ({@link runFlowInProcess}) does NOT yet thread
 *     per-spawn env into its adapter runners; the flow's own
 *     `makeSpawnOpts` ignores the env field today. Until that lands,
 *     the broker is started + torn down per run (so its lifecycle is
 *     exercised), but downstream subprocess traffic is NOT routed
 *     through it. Denies therefore come only from traffic the
 *     composition itself originates (currently none). Surfaced as a
 *     followup; the wiring is in place so a thread-through PR on the
 *     canonical flow immediately activates enforcement.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCiTripwireObserver,
  createEscalationEmitter,
  type WithEgressBrokerResult,
  withEgressBroker,
} from "@shamu/core-composition";
import type { FlowEvent } from "@shamu/core-flow";
import { EventBus as FlowBus } from "@shamu/core-flow";
import { EventBus as SupervisorBus } from "@shamu/core-supervisor";
import type { EscalationRaised, SupervisorEvent } from "@shamu/core-supervisor/events";
import { DEFAULT_ALLOWLISTS, type EgressPolicy, policyFromAllowlist } from "@shamu/egress-broker";
import type { LinearClient } from "@shamu/linear-client";
import {
  createEscalationSink,
  createLabelStateMachine,
  createPickupDriver,
  createRateLimiter,
  createRollingComment,
  createRunIssueRegistry,
  type LinearPickup,
  type PickupDriverHandle,
  type RateLimiter,
  RateLimiterOverflowError,
  type RollingCommentHandle,
  SHAMU_LABELS,
  type TokenLease,
} from "@shamu/linear-integration";
import type { WebhookServerHandle } from "@shamu/linear-webhook";
import type { ShamuDatabase } from "@shamu/persistence";
import { parseRunId, type RunId } from "@shamu/shared";
import type { Logger } from "@shamu/shared/logger";
import { createCiTripwire } from "@shamu/watchdog";
import { type FlowRunOutcome, runFlowInProcess } from "./flow-runner.ts";
import { pruneFlowShims } from "./flow-shim-prune.ts";

export interface LinearRuntimeOptions {
  readonly client: LinearClient;
  readonly teamId: string;
  readonly webhookServer: WebhookServerHandle;
  readonly db: ShamuDatabase;
  readonly logger: Logger;
  /** Flow module spec the daemon runs per pickup. Default: canonical flow. */
  readonly flowModuleSpec?: string;
  /** Workspace cwd passed to the flow. Default: `process.cwd()`. */
  readonly workspaceCwd?: string;
  /**
   * Optional task-description builder. Given the issueId, returns the
   * string forwarded to the flow as `initialInputs.task`. The default
   * fetches the issue's title+url and produces a "Work the Linear issue
   * ..." form.
   */
  readonly taskBuilder?: (issueId: string) => Promise<string>;
  /**
   * Test seam: substitute `runFlowInProcess`. Production callers leave
   * this unset — the real implementation is the default. Marked with a
   * leading underscore to signal "not a public contract".
   */
  readonly _runFlow?: (input: RuntimeRunFlowInput) => Promise<FlowRunOutcome>;
  /**
   * Rate-limiter caps. `global` defaults to 3; per-role defaults to
   * `{ planner: 1, executor: 2, reviewer: 1 }`. `queueCapacity` defaults
   * to 8.
   */
  readonly concurrency?: {
    readonly globalCap?: number;
    readonly perRoleCap?: Readonly<Record<string, number>>;
    readonly queueCapacity?: number;
  };
  /**
   * Default role when the pickup's flow DAG doesn't hint a role. Most
   * pickups run the canonical plan→execute→ci→review flow whose first
   * agent is an executor; defaulting here keeps the per-role cap
   * enforced.
   */
  readonly defaultRole?: string;
  /**
   * Optional egress policy override. When unset, the daemon derives a
   * policy from the union of {@link DEFAULT_ALLOWLISTS}, which is the
   * safest superset for a flow whose adapter mix isn't known at boot.
   * Pass `null` to skip the broker entirely (no proxy, no policy). Only
   * test + soak harnesses should skip.
   */
  readonly egressPolicy?: EgressPolicy | null;
  /**
   * Test seam: override the broker factory. Production callers leave
   * this unset. Receives the same args the production call would; must
   * return a `WithEgressBrokerResult`-shaped value.
   */
  readonly _withEgressBroker?: typeof withEgressBroker;
  /**
   * Directory to prune flow-shim scratchpad files from. Defaults to
   * `<cliRoot>/.shamu-flow-shim`. Set to `null` to disable prune.
   */
  readonly flowShimDir?: string | null;
  /**
   * Prune cadence (every Nth pickup). Default 50. Set to `0` to prune
   * only on boot.
   */
  readonly flowShimPruneEvery?: number;
}

/**
 * Subset of `FlowRunInput` the runtime hands to `_runFlow`. Mirrors the
 * real service contract so the production path type-checks against the
 * same signature as the test substitute.
 */
export interface RuntimeRunFlowInput {
  readonly moduleSpec: string;
  readonly task: string;
  readonly workspaceCwd: string;
  readonly db: ShamuDatabase;
  readonly logger: Logger;
  readonly flowBus: FlowBus<FlowEvent>;
  readonly outputMode: "silent";
  readonly signal: AbortSignal;
}

export interface LinearRuntimeHandle {
  /** Resolves when the runtime has finished starting. Rejects on boot failure. */
  readonly ready: Promise<void>;
  /** Resolves when the runtime's pickup drain loop exits. */
  readonly done: Promise<void>;
  /** Graceful shutdown. Idempotent; awaitable. Equivalent to `drainAndStop(0)`. */
  stop(): Promise<void>;
  /**
   * Stop intake without cancelling in-flight runs. Pickup events arriving
   * after `pause()` are ack'd + ignored. Idempotent.
   */
  pause(): void;
  /**
   * Wait up to `deadlineMs` for in-flight runs to finish, then cancel
   * any that are still running. After this resolves, the daemon is fully
   * drained and safe to exit.
   *
   * Callers can invoke `drainAndStop` without a prior `pause()`; the
   * implementation pauses intake as its first action so the drain is
   * guaranteed to make progress.
   */
  drainAndStop(deadlineMs: number): Promise<void>;
  /** Number of runs currently executing. Read-only. */
  readonly inFlight: number;
}

const DEFAULT_FLOW_MODULE = "@shamu/flows-plan-execute-review" as const;
const CI_NODE_ID = "ci" as const;
const DEFAULT_GLOBAL_CAP = 3;
const DEFAULT_PER_ROLE_CAP: Readonly<Record<string, number>> = Object.freeze({
  planner: 1,
  executor: 2,
  reviewer: 1,
});
const DEFAULT_QUEUE_CAPACITY = 8;
const DEFAULT_FLOW_SHIM_PRUNE_EVERY = 50;

/** Tracks one in-flight run for drain enumeration. */
interface InFlightRun {
  readonly runId: RunId;
  readonly issueId: string;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly role: string;
}

/**
 * Build the default egress policy — union of every vendor's allowlist.
 * Intentionally broad: the daemon doesn't know which adapter the flow
 * will spawn at runtime, so the safest default is "every vendor shamu
 * knows about." Operators with a narrower threat model should pass a
 * custom `egressPolicy`.
 */
function defaultEgressPolicy(): EgressPolicy {
  const hosts = new Set<string>();
  const suffixes = new Set<string>();
  for (const allowlist of Object.values(DEFAULT_ALLOWLISTS)) {
    for (const h of allowlist.allowedHosts) hosts.add(h);
    for (const s of allowlist.allowedHostSuffixes) suffixes.add(s);
  }
  return policyFromAllowlist(Array.from(hosts), Array.from(suffixes));
}

/**
 * Resolve the default flow-shim directory (`<cliRoot>/.shamu-flow-shim`).
 * `cliRoot` = `apps/cli/`. Relies on `import.meta.url` to locate the
 * runtime file; this file lives at `apps/cli/src/services/`.
 */
function defaultFlowShimDir(): string {
  const here = fileURLToPath(import.meta.url);
  // <cliRoot>/src/services/linear-runtime.ts → cliRoot
  const cliRoot = dirname(dirname(dirname(here)));
  return join(cliRoot, ".shamu-flow-shim");
}

/**
 * Create a daemon runtime. Returns a handle immediately; the returned
 * `ready` promise reflects boot success (label resolution + wiring).
 * Callers should `await handle.ready` before assuming the runtime is
 * listening for pickups.
 */
export async function createLinearRuntime(
  opts: LinearRuntimeOptions,
): Promise<LinearRuntimeHandle> {
  const moduleSpec = opts.flowModuleSpec ?? DEFAULT_FLOW_MODULE;
  const workspaceCwd = opts.workspaceCwd ?? process.cwd();
  const runFlow = opts._runFlow ?? ((input) => runFlowInProcess(input));
  const defaultRole = opts.defaultRole ?? "executor";
  const brokerStart = opts._withEgressBroker ?? withEgressBroker;
  const egressPolicy: EgressPolicy | null =
    opts.egressPolicy === null ? null : (opts.egressPolicy ?? defaultEgressPolicy());
  const shimDir = opts.flowShimDir === null ? null : (opts.flowShimDir ?? defaultFlowShimDir());
  const pruneEvery = opts.flowShimPruneEvery ?? DEFAULT_FLOW_SHIM_PRUNE_EVERY;

  const limiter = createRateLimiter({
    globalCap: opts.concurrency?.globalCap ?? DEFAULT_GLOBAL_CAP,
    perRoleCap: opts.concurrency?.perRoleCap ?? DEFAULT_PER_ROLE_CAP,
    queueCapacity: opts.concurrency?.queueCapacity ?? DEFAULT_QUEUE_CAPACITY,
  });

  // Long-lived primitives — created on every boot regardless of outcome
  // so shutdown paths have something to clean up even if listLabels
  // fails. (All of them are pure factories; nothing observable happens
  // until the first publish / subscribe.)
  const registry = createRunIssueRegistry();
  const labelMachine = createLabelStateMachine({ client: opts.client });
  const rollingComment = createRollingComment({ client: opts.client });
  const supervisorBus = new SupervisorBus<SupervisorEvent>();
  const escalationEmitter = createEscalationEmitter({ supervisorBus });
  const escalationSink = createEscalationSink({
    supervisorBus,
    client: opts.client,
    registry,
    labelMachine,
    logger: opts.logger,
  });

  let paused = false;
  let shutdownInFlight: Promise<void> | null = null;
  let pickupCount = 0;

  const inFlightRuns = new Map<RunId, InFlightRun>();

  const taskBuilder =
    opts.taskBuilder ??
    (async (issueId: string): Promise<string> => {
      const res = await opts.client.getIssue(issueId);
      if (!res.ok) {
        return `Work the Linear issue labeled shamu:ready: ${issueId}`;
      }
      const { identifier, title, url } = res.value;
      return `Work the Linear issue labeled shamu:ready: ${identifier} — ${title} (${url})`;
    });

  // Boot-time prune — swallow errors; it's best-effort hygiene.
  if (shimDir !== null) {
    void pruneFlowShims({ dir: shimDir }).catch((cause) => {
      opts.logger.warn("linear runtime: flow-shim boot prune threw", {
        dir: shimDir,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }

  async function flipBlockedWithReason(issueId: string, reason: string): Promise<void> {
    const labelRes = await labelMachine.transition({
      issueId,
      to: SHAMU_LABELS.blocked,
    });
    if (!labelRes.ok) {
      opts.logger.error("linear runtime: flip to blocked failed", {
        issueId,
        reason,
        kind: labelRes.error.kind,
        message: labelRes.error.message,
      });
    }
    const commentRes = await opts.client.createComment(issueId, `## Run blocked\n\n${reason}`);
    if (!commentRes.ok) {
      opts.logger.warn("linear runtime: blocked-reason comment failed", {
        issueId,
        reason,
        kind: commentRes.error.kind,
        message: commentRes.error.message,
      });
    }
  }

  /**
   * Route a broker `denied` event into the supervisor bus as
   * `escalation_raised` with `cause: "policy_violation"`. The existing
   * escalation sink already knows how to render that cause to Linear.
   */
  function publishEgressDenial(
    runId: RunId,
    role: string,
    event: {
      readonly host: string;
      readonly reason: string;
      readonly proxyMethod: string;
    },
  ): void {
    const escalation: EscalationRaised = {
      kind: "escalation_raised",
      swarmId: null,
      roleId: role,
      childId: runId,
      cause: "policy_violation",
      reason: `egress denied: ${event.host} (${event.proxyMethod}, ${event.reason})`,
      at: Date.now(),
      restartsInWindow: 0,
      target: "role",
    };
    supervisorBus.publish(escalation);
  }

  async function handlePickup(
    pickupEvent: LinearPickup,
    lease: TokenLease,
    runController: AbortController,
  ): Promise<void> {
    const { issueId, runId } = pickupEvent;
    let rolling: RollingCommentHandle | null = null;
    let brokerResult: WithEgressBrokerResult | null = null;

    try {
      const toInProgress = await labelMachine.transition({
        issueId,
        to: SHAMU_LABELS.inProgress,
      });
      if (!toInProgress.ok) {
        opts.logger.error("linear runtime: failed to flip to in-progress", {
          issueId,
          runId,
          kind: toInProgress.error.kind,
          message: toInProgress.error.message,
        });
      }

      let task: string;
      try {
        task = await taskBuilder(issueId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.logger.warn("linear runtime: taskBuilder threw, falling back", {
          issueId,
          runId,
          message,
        });
        task = `Work the Linear issue labeled shamu:ready: ${issueId}`;
      }

      const issueMetaRes = await opts.client.getIssue(issueId);
      const headline = issueMetaRes.ok
        ? `Run started — ${issueMetaRes.value.identifier}: ${issueMetaRes.value.title}`
        : `Run started — ${issueId}`;

      const commentRes = await rollingComment.begin({ issueId, runId, headline });
      if (!commentRes.ok) {
        opts.logger.error("linear runtime: rolling comment begin failed", {
          issueId,
          runId,
          kind: commentRes.error.kind,
          message: commentRes.error.message,
        });
      } else {
        rolling = commentRes.value;
      }

      // Per-run egress broker. Denied events flow through the supervisor
      // bus so the existing escalation sink lights up (label flip +
      // incident comment). Broker startup errors are logged but do NOT
      // abort the run — the flow runs without proxy wiring in that case,
      // same as before this track. Surfaced as a followup: "harden boot
      // so broker failure is fatal once env is threaded into runners".
      if (egressPolicy !== null) {
        try {
          brokerResult = await brokerStart({
            policy: egressPolicy,
            baseSpawnOpts: {
              runId,
              cwd: workspaceCwd,
            },
            onEvent: (type, ev): void => {
              if (type !== "denied") return;
              publishEgressDenial(runId, lease.role, {
                host: ev.host,
                reason: (ev as { reason?: string }).reason ?? "unknown",
                proxyMethod: (ev as { proxyMethod?: string }).proxyMethod ?? "unknown",
              });
            },
          });
        } catch (cause) {
          opts.logger.warn("linear runtime: egress broker start failed", {
            issueId,
            runId,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }

      // Per-run flow bus + CI tripwire + observer. Fresh bus per run so
      // subscriptions can't bleed across pickups.
      const flowBus = new FlowBus<FlowEvent>();
      const tripwire = createCiTripwire({ emitter: escalationEmitter.watchdogEmitter });
      const tripwireObserver = createCiTripwireObserver({
        tripwire,
        flowBus,
        ciNodeId: CI_NODE_ID,
        role: lease.role,
      });

      // Rolling-comment bridge — one checkpoint per node_completed /
      // node_failed. We skip the CI node (its shape is typed differently
      // and it already drives the tripwire observer above).
      //
      // Appends are serialized via a chained promise tail so the terminal
      // node's `updateComment` reliably lands BEFORE `finalize` runs.
      let appendTail: Promise<void> = Promise.resolve();
      const enqueueAppend = (task: () => Promise<void>): void => {
        appendTail = appendTail.then(task, task);
      };
      const commentBridgeDispose = flowBus.subscribe((ev: FlowEvent) => {
        if (rolling === null) return;
        const handle = rolling;
        if (ev.kind === "node_completed" && ev.nodeId !== CI_NODE_ID) {
          enqueueAppend(async () => {
            try {
              const res = await handle.appendCheckpoint({
                at: ev.at,
                headline: `Node ${ev.nodeId} completed (ok=${ev.output.ok}, dur=${ev.durationMs}ms)`,
              });
              if (!res.ok) {
                opts.logger.warn("linear runtime: checkpoint append failed", {
                  issueId,
                  runId,
                  nodeId: ev.nodeId,
                  kind: res.error.kind,
                  message: res.error.message,
                });
              }
            } catch (cause) {
              opts.logger.error("linear runtime: checkpoint append threw", {
                issueId,
                runId,
                nodeId: ev.nodeId,
                cause: cause instanceof Error ? cause.message : String(cause),
              });
            }
          });
        } else if (ev.kind === "node_failed") {
          enqueueAppend(async () => {
            try {
              const res = await handle.appendCheckpoint({
                at: ev.at,
                headline: `Node ${ev.nodeId} failed: ${ev.error.message}`,
                detail: `retriable=${ev.error.retriable} willRetry=${ev.willRetry}`,
              });
              if (!res.ok) {
                opts.logger.warn("linear runtime: failure-checkpoint append failed", {
                  issueId,
                  runId,
                  nodeId: ev.nodeId,
                  kind: res.error.kind,
                  message: res.error.message,
                });
              }
            } catch (cause) {
              opts.logger.error("linear runtime: failure-checkpoint append threw", {
                issueId,
                runId,
                nodeId: ev.nodeId,
                cause: cause instanceof Error ? cause.message : String(cause),
              });
            }
          });
        }
      });

      let outcome: FlowRunOutcome;
      let cancelled = false;
      try {
        outcome = await runFlow({
          moduleSpec,
          task,
          workspaceCwd,
          db: opts.db,
          logger: opts.logger,
          flowBus,
          outputMode: "silent",
          signal: runController.signal,
        });
      } catch (cause) {
        // An AbortSignal-driven cancellation surfaces as a rejection
        // inside runFlow; treat that as a synthetic "failed" outcome so
        // the downstream label-flip + comment path is uniform.
        cancelled = runController.signal.aborted;
        outcome = {
          flowRunId: "" as never,
          status: "failed",
          totalCostUsd: null,
        };
        if (!cancelled) {
          // Real error — rethrow so the outer catch below escalates.
          commentBridgeDispose();
          tripwireObserver.stop();
          throw cause;
        }
      } finally {
        commentBridgeDispose();
        tripwireObserver.stop();
      }

      // Drain every queued append before finalizing.
      try {
        await appendTail;
      } catch {
        // best-effort drain
      }

      const summary = cancelled
        ? "Terminal status: cancelled (shutdown drain)"
        : `Terminal status: ${outcome.status}, cost: ${outcome.totalCostUsd ?? "null"}`;
      if (rolling) {
        const finalRes = await rolling.finalize(summary);
        if (!finalRes.ok) {
          opts.logger.warn("linear runtime: rolling comment finalize failed", {
            issueId,
            runId,
            kind: finalRes.error.kind,
            message: finalRes.error.message,
          });
        }
      }

      if (cancelled) {
        await flipBlockedWithReason(issueId, "shutdown: drained before completion");
      } else if (outcome.status === "succeeded") {
        const toReview = await labelMachine.transition({
          issueId,
          to: SHAMU_LABELS.review,
        });
        if (!toReview.ok) {
          opts.logger.error("linear runtime: flip to review failed", {
            issueId,
            runId,
            kind: toReview.error.kind,
            message: toReview.error.message,
          });
        }
      } else if (outcome.status === "failed") {
        const toBlocked = await labelMachine.transition({
          issueId,
          to: SHAMU_LABELS.blocked,
        });
        if (!toBlocked.ok) {
          opts.logger.error("linear runtime: flip to blocked failed", {
            issueId,
            runId,
            kind: toBlocked.error.kind,
            message: toBlocked.error.message,
          });
        }
        const incidentRes = await opts.client.createComment(
          issueId,
          `## Run failed\n\nRun ${runId} finished with status \`failed\`. See the rolling comment above for per-node checkpoints.`,
        );
        if (!incidentRes.ok) {
          opts.logger.warn("linear runtime: failure incident comment failed", {
            issueId,
            runId,
            kind: incidentRes.error.kind,
            message: incidentRes.error.message,
          });
        }
      }
      // paused → leave labels at in-progress; a human must resolve the gate.
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      opts.logger.error("linear runtime: pickup handler threw", {
        issueId,
        runId,
        cause: message,
      });
      if (rolling !== null) {
        void rolling
          .appendCheckpoint({
            at: Date.now(),
            headline: "Pickup handler crashed",
            detail: message,
          })
          .catch(() => undefined);
      }
      await flipBlockedWithReason(issueId, `pickup handler crashed: ${message}`).catch(
        () => undefined,
      );
    } finally {
      if (brokerResult) {
        try {
          await brokerResult.shutdown();
        } catch (cause) {
          opts.logger.warn("linear runtime: broker shutdown threw", {
            issueId,
            runId,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      lease.release();
      inFlightRuns.delete(runId);
      registry.release(parseRunId(runId));
    }
  }

  function announceDrainBanner(): void {
    for (const run of inFlightRuns.values()) {
      // Best-effort banner annotation on the rolling comment. We can't
      // reach the rolling handle here (it's scoped inside `handlePickup`);
      // instead we append a sibling comment which is visible in Linear's
      // thread right above the rolling update.
      void opts.client
        .createComment(
          run.issueId,
          "## shamu daemon\n\nEntering drain; will finish this run before shutdown.",
        )
        .catch((cause) => {
          opts.logger.warn("linear runtime: drain banner comment failed", {
            issueId: run.issueId,
            runId: run.runId,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        });
    }
  }

  /**
   * Spawn the per-run handler on a detached promise and register it in
   * `inFlightRuns` for drain enumeration. Intentionally synchronous so
   * the pickup driver isn't blocked on the handler.
   */
  function spawnHandler(event: LinearPickup, lease: TokenLease): void {
    const runId = parseRunId(event.runId);
    const controller = new AbortController();
    const runPromise: Promise<void> = handlePickup(event, lease, controller).catch((cause) => {
      opts.logger.error("linear runtime: detached handlePickup rejected", {
        runId,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    });
    inFlightRuns.set(runId, {
      runId,
      issueId: event.issueId,
      controller,
      done: runPromise,
      role: lease.role,
    });
  }

  /**
   * Pickup entry point — the driver awaits this, but the handler itself
   * runs detached so a slow run can't backpressure webhook delivery. The
   * only `await` here is the drain / prune hygiene that the driver can
   * safely block on; limiter waits move to a background promise so the
   * driver stays responsive.
   */
  function onPickup(event: LinearPickup): Promise<void> {
    pickupCount += 1;
    if (paused) {
      opts.logger.info("linear runtime: pickup ignored (paused)", {
        issueId: event.issueId,
        runId: event.runId,
      });
      registry.release(parseRunId(event.runId));
      return Promise.resolve();
    }

    // Periodic flow-shim prune. `pruneEvery=0` disables periodic prune.
    if (shimDir !== null && pruneEvery > 0 && pickupCount % pruneEvery === 0) {
      void pruneFlowShims({ dir: shimDir })
        .then((res) => {
          if (res.removed > 0 || res.errors > 0) {
            opts.logger.info("linear runtime: flow-shim prune", {
              dir: shimDir,
              removed: res.removed,
              scanned: res.scanned,
              errors: res.errors,
            });
          }
        })
        .catch((cause) => {
          opts.logger.warn("linear runtime: flow-shim prune threw", {
            dir: shimDir,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        });
    }

    const role = defaultRole;

    // Fast path: free headroom.
    const immediate = limiter.tryAcquire(role, event.runId);
    if (immediate !== null) {
      spawnHandler(event, immediate);
      return Promise.resolve();
    }

    // Slow path: try to park on the queue. If that rejects with
    // overflow, flip blocked. If it resolves later (cap freed up), spawn
    // the handler then. Either way, return immediately so the pickup
    // driver proceeds to the next event.
    void (async (): Promise<void> => {
      try {
        const lease = await limiter.acquire(role, event.runId);
        if (paused) {
          // Paused mid-wait — drop the pickup, release the lease.
          lease.release();
          registry.release(parseRunId(event.runId));
          return;
        }
        spawnHandler(event, lease);
      } catch (cause) {
        if (cause instanceof RateLimiterOverflowError) {
          opts.logger.warn("linear runtime: rate-limit overflow; flipping blocked", {
            issueId: event.issueId,
            runId: event.runId,
            inFlight: limiter.inFlight,
            queueLength: limiter.queueLength,
          });
          await flipBlockedWithReason(
            event.issueId,
            `rate-limit: queue-full (${limiter.inFlight} runs in flight)`,
          ).catch(() => undefined);
        } else {
          opts.logger.error("linear runtime: limiter.acquire threw", {
            issueId: event.issueId,
            runId: event.runId,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        }
        registry.release(parseRunId(event.runId));
      }
    })();
    return Promise.resolve();
  }

  // Defer the heavy side of boot — label resolution + pickup-driver
  // wiring — so we can return a handle whose `ready` promise reflects
  // the outcome.
  const pickupRef: { current: PickupDriverHandle | null } = { current: null };

  const ready = (async (): Promise<void> => {
    const labelsRes = await opts.client.listLabels(opts.teamId);
    if (!labelsRes.ok) {
      const { error } = labelsRes;
      throw new Error(`Linear listLabels failed: ${error.kind}: ${error.message}`);
    }
    const readyLabel = labelsRes.value.find((l) => l.name === SHAMU_LABELS.ready);
    if (!readyLabel) {
      throw new Error(
        `Linear team missing shamu:ready label (teamId=${opts.teamId}). ` +
          `Create the label in Linear before running the daemon.`,
      );
    }
    const readyLabelId = readyLabel.id;

    pickupRef.current = createPickupDriver({
      handle: opts.webhookServer,
      registry,
      isReadyLabelId: (labelId): boolean => labelId === readyLabelId,
      logger: opts.logger,
      onPickup: (event: LinearPickup): Promise<void> => {
        // Return the rate-limiter acquisition promise so the pickup
        // driver's back-pressure covers the "queue full and waiting"
        // case. If acquisition rejects via overflow, `onPickup` handles
        // it internally and resolves.
        return onPickup(event);
      },
    });
  })();

  const done = (async (): Promise<void> => {
    try {
      await ready;
    } catch {
      return;
    }
    if (pickupRef.current) await pickupRef.current.done.catch(() => undefined);
  })();

  function pause(): void {
    if (paused) return;
    paused = true;
    opts.logger.info("linear runtime: paused", {});
  }

  async function drainAndStop(deadlineMs: number): Promise<void> {
    if (shutdownInFlight) return shutdownInFlight;
    shutdownInFlight = (async (): Promise<void> => {
      pause();

      // Stop the pickup driver — no new pickups from this point on.
      // `pickupRef.current.stop()` awaits the drain loop, not in-flight
      // handlers.
      try {
        await ready;
      } catch {
        // Boot failed; nothing else to do.
      }
      if (pickupRef.current) {
        await pickupRef.current.stop().catch((cause) => {
          opts.logger.warn("linear runtime: pickup.stop threw", {
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        });
      }

      // Announce drain on every in-flight issue.
      if (inFlightRuns.size > 0 && deadlineMs > 0) {
        announceDrainBanner();
      }

      // Wait for in-flight runs up to deadlineMs; on timeout cancel the
      // remaining controllers + wait for their finalize paths.
      if (inFlightRuns.size > 0) {
        const deadlineReached = new Promise<void>((resolve) => {
          if (deadlineMs <= 0) {
            resolve();
            return;
          }
          const timer = setTimeout(() => resolve(), deadlineMs);
          // Unref so a hung run doesn't keep the event loop alive past
          // the deadline in Node-style hosts; best-effort (ref() is a
          // Node-only method).
          const t = timer as unknown as { unref?: () => void };
          t.unref?.();
        });
        const allDone = Promise.all(Array.from(inFlightRuns.values()).map((run) => run.done)).then(
          () => undefined,
        );
        await Promise.race([allDone, deadlineReached]);

        if (inFlightRuns.size > 0) {
          opts.logger.warn("linear runtime: drain deadline reached; cancelling runs", {
            remaining: inFlightRuns.size,
          });
          for (const run of inFlightRuns.values()) {
            run.controller.abort(new Error("shutdown: drained before completion"));
          }
          // Give the cancelled runs a final beat to complete their
          // finalize paths (label flip to blocked + comment). These
          // paths already live under a best-effort try/catch inside
          // `handlePickup` so we don't need another deadline here.
          await Promise.all(Array.from(inFlightRuns.values()).map((run) => run.done));
        }
      }

      try {
        await opts.webhookServer.stop();
      } catch (cause) {
        opts.logger.warn("linear runtime: webhookServer.stop threw", {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      }
      escalationSink.stop();
      escalationEmitter.stop();
      registry.clear();
    })();
    return shutdownInFlight;
  }

  const stop = (): Promise<void> => drainAndStop(0);

  return {
    ready,
    done,
    stop,
    pause,
    drainAndStop,
    get inFlight(): number {
      return inFlightRuns.size;
    },
  };
}

// Export for tests that need to synthesize the limiter independently.
export type { RateLimiter };
