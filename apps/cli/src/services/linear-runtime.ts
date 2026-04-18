/**
 * Linear daemon runtime — composition root for `shamu linear serve`.
 *
 * Phase 6.C.3 wiring:
 *
 *   1. Resolve the `shamu:ready` label id via `client.listLabels(teamId)`.
 *   2. Start a pickup driver against the supplied webhook server.
 *   3. For each pickup:
 *        a. Flip the issue to `shamu:in-progress`.
 *        b. Begin a rolling comment; bridge flow checkpoints into it.
 *        c. Instantiate a per-run CI tripwire + observer.
 *        d. Run the canonical flow via `runFlowInProcess`.
 *        e. Finalize the rolling comment and flip labels:
 *             - succeeded → `shamu:review`
 *             - failed    → `shamu:blocked` (idempotent with the
 *                           escalation sink, which also flips to blocked)
 *        f. Release the run↔issue binding + stop the observer.
 *   4. An escalation sink on the supervisor bus handles
 *      `escalation_raised` independently of the per-pickup path
 *      (incident comment + flip to blocked).
 *
 * Layering: the composition lives in `apps/cli/` per Phase 6.C.2. The
 * `@shamu/linear-integration` package stays primitive-only; wiring is
 * exclusively this file's job.
 *
 * Serialization: `PickupDriverHandle.onPickup` is awaited, which means
 * runs execute one-at-a-time. That's the designed 6.C MVP behavior —
 * Phase 8.A adds rate-limiting + concurrency + graceful drain-on-shutdown.
 *
 * Test seam: `_runFlow` is a private option for tests so the unit suite
 * can substitute `runFlowInProcess` with a synchronous stub. It is NOT
 * part of the public contract; production callers in
 * `apps/cli/src/commands/linear/` pass nothing and the real runner is used.
 */

import { createCiTripwireObserver, createEscalationEmitter } from "@shamu/core-composition";
import type { FlowEvent } from "@shamu/core-flow";
import { EventBus as FlowBus } from "@shamu/core-flow";
import { EventBus as SupervisorBus } from "@shamu/core-supervisor";
import type { SupervisorEvent } from "@shamu/core-supervisor/events";
import type { LinearClient } from "@shamu/linear-client";
import {
  createEscalationSink,
  createLabelStateMachine,
  createPickupDriver,
  createRollingComment,
  createRunIssueRegistry,
  type LinearPickup,
  type PickupDriverHandle,
  type RollingCommentHandle,
  SHAMU_LABELS,
} from "@shamu/linear-integration";
import type { WebhookServerHandle } from "@shamu/linear-webhook";
import type { ShamuDatabase } from "@shamu/persistence";
import { parseRunId } from "@shamu/shared";
import type { Logger } from "@shamu/shared/logger";
import { createCiTripwire } from "@shamu/watchdog";
import { type FlowRunOutcome, runFlowInProcess } from "./flow-runner.ts";

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
}

export interface LinearRuntimeHandle {
  /** Resolves when the runtime has finished starting. Rejects on boot failure. */
  readonly ready: Promise<void>;
  /** Resolves when the runtime's pickup drain loop exits. */
  readonly done: Promise<void>;
  /** Graceful shutdown. Idempotent; awaitable. */
  stop(): Promise<void>;
}

const DEFAULT_FLOW_MODULE = "@shamu/flows-plan-execute-review" as const;
const CI_NODE_ID = "ci" as const;

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

  let stopped = false;
  let shutdownInFlight: Promise<void> | null = null;

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

  async function handlePickup(pickupEvent: LinearPickup, readyLabelId: string): Promise<void> {
    void readyLabelId; // parameter captured for debugging / future filtering
    const { issueId, runId } = pickupEvent;
    let rolling: RollingCommentHandle | null = null;

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
        // Keep going — the escalation sink still covers watchdog paths.
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

      // Per-run flow bus + CI tripwire + observer. Fresh bus per run so
      // subscriptions can't bleed across pickups.
      const flowBus = new FlowBus<FlowEvent>();
      const tripwire = createCiTripwire({ emitter: escalationEmitter.watchdogEmitter });
      const tripwireObserver = createCiTripwireObserver({
        tripwire,
        flowBus,
        ciNodeId: CI_NODE_ID,
        role: "executor",
      });

      // Rolling-comment bridge — one checkpoint per node_completed /
      // node_failed. We skip the CI node (its shape is typed differently
      // and it already drives the tripwire observer above).
      //
      // Appends are serialized via a chained promise tail so the terminal
      // node's `updateComment` reliably lands BEFORE `finalize` runs. Per
      // 6.D followup #1 — with fire-and-forget `void rolling.append(...)`
      // semantics the final node's append could race `finalize`: both
      // call `updateComment` with snapshots of the in-memory body and
      // whichever lands last wins, silently dropping the terminal
      // checkpoint from the Linear-visible body. Awaiting the tail before
      // `finalize` eliminates the race without needing a mutex inside
      // `createRollingComment` (the primitive stays simple; the bridge
      // owns ordering because the bridge is what's firing concurrent
      // events).
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
      try {
        outcome = await runFlow({
          moduleSpec,
          task,
          workspaceCwd,
          db: opts.db,
          logger: opts.logger,
          flowBus,
          outputMode: "silent",
        });
      } finally {
        commentBridgeDispose();
        tripwireObserver.stop();
      }

      // Drain every queued append before finalizing so the terminal node's
      // checkpoint is guaranteed to be in the in-memory body (and in
      // Linear) when `finalize` runs. Any append that rejected its inner
      // task already logged above; we swallow the rejection here so a
      // transient Linear error can't short-circuit the finalize path.
      try {
        await appendTail;
      } catch {
        // best-effort drain
      }

      const summary = `Terminal status: ${outcome.status}, cost: ${outcome.totalCostUsd ?? "null"}`;
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

      if (outcome.status === "succeeded") {
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
        // Belt-and-suspenders: if the flow failed without an escalation
        // event (e.g. non-retriable runner error bypassing the watchdog
        // path), flip to blocked here. The label machine is idempotent,
        // so this is safe when the escalation sink has already flipped.
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
      const toBlocked = await labelMachine.transition({
        issueId,
        to: SHAMU_LABELS.blocked,
      });
      if (!toBlocked.ok) {
        opts.logger.error("linear runtime: flip to blocked (after crash) failed", {
          issueId,
          runId,
          kind: toBlocked.error.kind,
          message: toBlocked.error.message,
        });
      }
    } finally {
      registry.release(parseRunId(runId));
    }
  }

  // Defer the heavy side of boot — label resolution + pickup-driver
  // wiring — so we can return a handle whose `ready` promise reflects
  // the outcome. Throwing synchronously would make early-fail tests
  // noisier than needed.
  //
  // The reference is kept inside a mutable holder rather than a bare
  // `let`. Bare `let` with a `null` initializer and an assignment inside
  // a nested async IIFE confuses TypeScript's control-flow analysis
  // across closure boundaries (narrows to `never`); the holder pattern
  // makes the widened type explicit.
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
      onPickup: async (event: LinearPickup): Promise<void> => {
        if (stopped) return;
        await handlePickup(event, readyLabelId);
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

  const runtimeStop = async (): Promise<void> => {
    if (shutdownInFlight) return shutdownInFlight;
    shutdownInFlight = (async (): Promise<void> => {
      stopped = true;
      // Even if `ready` rejected, we still run the teardown — the sinks
      // exist regardless.
      try {
        await ready;
      } catch {
        // Boot failed; nothing to stop on the pickup side.
      }
      if (pickupRef.current) {
        await pickupRef.current.stop().catch((cause) => {
          opts.logger.warn("linear runtime: pickup.stop threw", {
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        });
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
  };

  return {
    ready,
    done,
    stop: runtimeStop,
  };
}
