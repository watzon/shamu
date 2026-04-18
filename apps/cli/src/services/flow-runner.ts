/**
 * `runFlowInProcess` — shared in-process flow runner.
 *
 * Extracted from `apps/cli/src/commands/flow/run.ts` as part of Phase
 * 6.C.3 so the `shamu linear serve` daemon can reuse the exact same
 * load-validate-execute-persist path that `shamu flow run` uses, without
 * forking a subprocess per pickup. The command handler continues to own
 * stdout framing, SIGINT/SIGTERM wiring, and DB lifecycle; this service
 * is purely the engine-run core:
 *
 *   1. Load the flow module via {@link loadFlowModule}.
 *   2. Optionally rehydrate state from a `flow_runs` row (resume path).
 *   3. Register runners on a fresh {@link RunnerRegistry}.
 *   4. Attach persistence + logger sinks to the caller-supplied `flowBus`.
 *   5. Run {@link FlowEngine.run} to completion (or cancellation via
 *      `opts.signal`).
 *   6. Flush the final state row to SQLite.
 *   7. Return `{ flowRunId, status, totalCostUsd }`.
 *
 * The `flowBus` is injected by the caller so additional subscribers (the
 * daemon's rolling-comment bridge, a CI-tripwire observer, a dashboard
 * projector, …) can be attached BEFORE the engine fires `flow_started`.
 *
 * Silent output mode — `outputMode: "silent"` — gates every `process.stdout`
 * write so the daemon's NDJSON log stays clean. `"json"` and `"human"`
 * mirror the existing `shamu flow run` framing byte-for-byte.
 *
 * Ownership boundaries the caller MUST respect:
 *
 *   - The caller owns `db`. `runFlowInProcess` never closes it — that
 *     would break the daemon (which reuses one DB across many runs).
 *   - The caller owns signal handlers. `runFlowInProcess` never installs
 *     `process.on("SIGINT"/"SIGTERM")` — it only listens to `opts.signal`
 *     if provided.
 *   - The caller owns the output mode. Passing `"silent"` suppresses
 *     stdout; the function still writes to the injected logger.
 */

import type { FlowEvent, FlowRunState } from "@shamu/core-flow";
import {
  deserialize,
  type EventBus,
  FlowEngine,
  RunnerRegistry,
  serialize,
} from "@shamu/core-flow";
import type { ShamuDatabase } from "@shamu/persistence";
import * as flowRunsQueries from "@shamu/persistence/queries/flow-runs";
import type { WorkflowRunId } from "@shamu/shared";
import { newWorkflowRunId } from "@shamu/shared";
import {
  type FlowModule,
  FlowModuleContractError,
  loadFlowModule,
  type RegisterRunnersOptions,
} from "../commands/flow-contract.ts";
import { writeDiag, writeHuman, writeJson } from "../output.ts";
import type { Logger } from "./types.ts";

export type FlowRunnerOutputMode = "json" | "human" | "silent";

export interface FlowRunInput {
  /** Package name (e.g. "@shamu/flows-plan-execute-review") or path to the flow module. */
  readonly moduleSpec: string;
  /** Task description forwarded to the flow as `initialInputs.task`. */
  readonly task: string;
  /** Working directory passed to `registerRunners`. */
  readonly workspaceCwd: string;
  /**
   * Options forwarded to `flowModule.parseOptions(...)`. The caller is
   * expected to have already validated + serialized them; this mirrors
   * the exact map `shamu flow run` hands to `parseOptions`.
   */
  readonly flowOpts?: Readonly<Record<string, string>>;
  /** Max-iterations override; injected into `flowOpts.maxIterations`. */
  readonly maxIterations?: number | null;
  /**
   * Resume target. When non-null, the runner loads the prior `flow_runs`
   * row, deserializes `state_json`, and threads it through
   * `engine.run({ resumeFrom })`. The returned `flowRunId` matches the
   * prior row's id (appending state, not forking).
   */
  readonly resumeFlowRunId?: WorkflowRunId | null;
  /** Open SQLite handle. Never closed by this service. */
  readonly db: ShamuDatabase;
  /** Structured logger; one `flow: <kind>` entry per bus event. */
  readonly logger: Logger;
  /**
   * Caller-injected bus. Subscribers attached BEFORE `runFlowInProcess`
   * returns will see every bus event the engine publishes. Useful for
   * rolling-comment bridges, CI-tripwire observers, dashboard projectors.
   */
  readonly flowBus: EventBus<FlowEvent>;
  /** Cancellation signal forwarded to `engine.run`. */
  readonly signal?: AbortSignal;
  /** stdout framing. `"silent"` suppresses all stdout writes. */
  readonly outputMode?: FlowRunnerOutputMode;
}

export interface FlowRunOutcome {
  readonly flowRunId: WorkflowRunId;
  readonly status: FlowTerminalStatus;
  readonly totalCostUsd: number | null;
}

export type FlowTerminalStatus = "succeeded" | "failed" | "paused";

/**
 * Error raised when the flow module can't be loaded or fails its
 * `registerRunners`/`parseOptions` contract. Callers can catch and map
 * to `ExitCode.USAGE` / `ExitCode.INTERNAL` as appropriate.
 */
export class FlowRunnerUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowRunnerUsageError";
  }
}

/**
 * Run a flow to completion in-process. See module doc for the full
 * ownership + framing contract. Throws {@link FlowRunnerUsageError} for
 * caller-fixable problems (missing resume row, bad module); any other
 * thrown error represents an internal engine / persistence fault.
 */
export async function runFlowInProcess(input: FlowRunInput): Promise<FlowRunOutcome> {
  const mode: FlowRunnerOutputMode = input.outputMode ?? "silent";

  // 1. Load + contract-check the flow module.
  let flowModule: FlowModule;
  try {
    flowModule = await loadFlowModule(input.moduleSpec);
  } catch (err) {
    if (err instanceof FlowModuleContractError) {
      throw new FlowRunnerUsageError(err.message);
    }
    // Import errors, syntax errors, etc. propagate as internal faults.
    throw err;
  }

  // 2. Compose parse-options: forward any `flowOpts` the caller gave us
  // plus the max-iterations override so the module's `parseOptions` sees
  // one unified record (matches `shamu flow run`'s existing behavior).
  const flowOpts: Record<string, string> = { ...(input.flowOpts ?? {}) };
  if (typeof input.maxIterations === "number") {
    flowOpts.maxIterations = String(input.maxIterations);
  }

  let parseOpts: Partial<RegisterRunnersOptions> = {};
  if (flowModule.parseOptions !== undefined) {
    try {
      parseOpts = flowModule.parseOptions(flowOpts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new FlowRunnerUsageError(`parseOptions threw: ${message}`);
    }
  } else if (typeof input.maxIterations === "number") {
    parseOpts = { maxIterations: input.maxIterations };
  }
  const registerOpts: RegisterRunnersOptions = {
    workspaceCwd: input.workspaceCwd,
    ...parseOpts,
  };

  // 3. Resume path: rehydrate state + reuse the prior id.
  let resumeFrom: FlowRunState | null = null;
  let flowRunId: WorkflowRunId = newWorkflowRunId();
  if (input.resumeFlowRunId) {
    const priorId = input.resumeFlowRunId;
    const row = flowRunsQueries.getFlowRun(input.db, priorId);
    if (!row) {
      throw new FlowRunnerUsageError(`--resume '${priorId}' not found in flow_runs`);
    }
    try {
      resumeFrom = deserialize(row.stateJson);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`failed to deserialize prior state: ${message}`);
    }
    flowRunId = priorId;
  }

  // 4. Register runners.
  const registry = new RunnerRegistry();
  try {
    flowModule.registerRunners(registry, registerOpts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`registerRunners threw: ${message}`);
  }

  const bus = input.flowBus;
  let latestState: FlowRunState | null = resumeFrom;
  let flowRowCreated = resumeFrom !== null;

  // Logger + stdout sink. We subscribe BEFORE invoking engine.run so the
  // flow_started event is captured. Writes are gated on `mode` so silent
  // mode emits nothing to stdout (the daemon's requirement).
  const sinkDispose = bus.subscribe((ev) => {
    input.logger.info(`flow: ${ev.kind}`, {
      flowRunId: ev.flowRunId,
      ...eventLogContext(ev),
    });
    if (mode === "silent") return;
    if (mode === "json") {
      process.stdout.write(`${JSON.stringify(toJsonEvent(ev))}\n`);
    } else {
      writeHuman(mode, formatFlowEventLine(ev));
    }
  });

  // Persistence sink: write flow_runs row on flow_started. `flushTerminal`
  // below handles the terminal update.
  const persistDispose = bus.subscribe((ev) => {
    try {
      if (ev.kind === "flow_started") {
        if (!flowRowCreated) {
          flowRunsQueries.insertFlowRun(input.db, {
            flowRunId: ev.flowRunId,
            flowId: ev.flowId,
            dagVersion: ev.version,
            status: "running",
            stateJson: serialize(
              latestState ?? {
                flowRunId: ev.flowRunId,
                flowId: ev.flowId,
                version: ev.version,
                entry: flowModule.flowDefinition.entry,
                nodeStatus: {},
                nodeOutputs: {},
                pendingGate: null,
                startedAt: ev.at,
                updatedAt: ev.at,
                totalCostUsd: null,
                costSamples: [],
              },
            ),
            resumedFrom: ev.resumedFrom,
            startedAt: ev.at,
          });
          flowRowCreated = true;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Diagnostics go to stderr regardless of mode — a persistence write
      // failure is operator-visible.
      writeDiag(`flow run: persistence failure on ${ev.kind}: ${message}`);
    }
  });

  const engine = new FlowEngine({ registry, bus });
  const signal = input.signal ?? new AbortController().signal;

  try {
    const finalState = await engine.run(flowModule.flowDefinition, {
      flowRunId,
      initialInputs: { task: input.task },
      ...(resumeFrom !== null ? { resumeFrom } : {}),
      signal,
    });
    latestState = finalState;
  } finally {
    sinkDispose();
    persistDispose();
  }

  const terminalStatus = deriveTerminalStatus(latestState);

  // Flush final state + status to SQLite. If flow_started didn't fire for
  // some reason (cancelled before first publish), `insertFlowRun` acts as
  // a belt-and-suspenders record.
  if (latestState !== null) {
    try {
      if (!flowRowCreated) {
        flowRunsQueries.insertFlowRun(input.db, {
          flowRunId: latestState.flowRunId,
          flowId: latestState.flowId,
          dagVersion: latestState.version,
          status: terminalStatus,
          stateJson: serialize(latestState),
          resumedFrom: null,
          startedAt: latestState.startedAt,
        });
        flowRowCreated = true;
      } else {
        flowRunsQueries.updateFlowRunState(
          input.db,
          latestState.flowRunId,
          terminalStatus,
          serialize(latestState),
          Date.now(),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`flow run: failed to flush final state: ${message}`);
    }
  }

  // Summary output mirrors the existing `shamu flow run` surface exactly
  // (JSON line + human line); silent mode suppresses both.
  if (mode === "json") {
    writeJson(mode, {
      kind: "flow-run-summary",
      flowRunId,
      status: terminalStatus,
      totalCostUsd: latestState?.totalCostUsd ?? null,
    });
  } else if (mode === "human") {
    writeHuman(
      mode,
      `flow ${flowRunId} ${terminalStatus} (cost=${latestState?.totalCostUsd ?? "null"})`,
    );
  }

  return {
    flowRunId,
    status: terminalStatus,
    totalCostUsd: latestState?.totalCostUsd ?? null,
  };
}

// ---------------------------------------------------------------------------
// Helpers — duplicated from the original flow/run.ts, kept module-private
// here because both the command and the daemon need them byte-identical.
// ---------------------------------------------------------------------------

/**
 * Derive the terminal status from the last engine state. The engine
 * emits `flow_completed` with its own status, but callers care about
 * the state-driven view (which also covers forced shutdown).
 */
export function deriveTerminalStatus(state: FlowRunState | null): FlowTerminalStatus {
  if (state === null) return "failed";
  if (state.pendingGate !== null) return "paused";
  for (const status of Object.values(state.nodeStatus)) {
    if (status === "failed") return "failed";
    if (status === "running" || status === "pending") return "failed";
    if (status === "paused") return "paused";
  }
  return "succeeded";
}

/**
 * Strip the `kind` discriminator so JSON listeners get a typed envelope
 * `{ ts, kind, flowRunId, payload }` rather than the raw union shape.
 * Per the 4.C JSON schema.
 */
export function toJsonEvent(ev: FlowEvent): {
  readonly ts: number;
  readonly kind: string;
  readonly flowRunId: string;
  readonly payload: Record<string, unknown>;
} {
  switch (ev.kind) {
    case "flow_started": {
      const { kind, at, flowRunId, ...rest } = ev;
      return { ts: at, kind, flowRunId, payload: rest };
    }
    case "node_started": {
      const { kind, at, flowRunId, ...rest } = ev;
      return { ts: at, kind, flowRunId, payload: rest };
    }
    case "node_completed": {
      const { kind, at, flowRunId, ...rest } = ev;
      return { ts: at, kind, flowRunId, payload: rest };
    }
    case "node_failed": {
      const { kind, at, flowRunId, ...rest } = ev;
      return { ts: at, kind, flowRunId, payload: rest };
    }
    case "human_gate_reached": {
      const { kind, at, flowRunId, ...rest } = ev;
      return { ts: at, kind, flowRunId, payload: rest };
    }
    case "flow_completed": {
      const { kind, at, flowRunId, ...rest } = ev;
      return { ts: at, kind, flowRunId, payload: rest };
    }
  }
}

/** Human one-liner per event kind — mirrors `shamu flow run`'s default output. */
export function formatFlowEventLine(ev: FlowEvent): string {
  const head = `[flow ${ev.flowRunId}] ${ev.kind}`;
  switch (ev.kind) {
    case "flow_started":
      return `${head} flowId=${ev.flowId} v=${ev.version}`;
    case "node_started":
      return `${head} node=${ev.nodeId} attempt=${ev.attempt}${ev.role ? ` role=${ev.role}` : ""}`;
    case "node_completed":
      return `${head} node=${ev.nodeId} ok=${ev.output.ok} cached=${ev.cached} dur=${ev.durationMs}ms cost=${ev.output.costUsd ?? "null"}`;
    case "node_failed":
      return `${head} node=${ev.nodeId} retriable=${ev.error.retriable} willRetry=${ev.willRetry}: ${ev.error.message}`;
    case "human_gate_reached":
      return `${head} node=${ev.nodeId} resumeToken=${ev.resumeToken}`;
    case "flow_completed":
      return `${head} status=${ev.status} cost=${ev.totalCostUsd ?? "null"} nodes=${ev.nodeCount}`;
  }
}

/** Structured logger context per event kind. */
export function eventLogContext(ev: FlowEvent): Record<string, unknown> {
  switch (ev.kind) {
    case "flow_started":
      return { flowId: ev.flowId, version: ev.version, resumedFrom: ev.resumedFrom };
    case "node_started":
      return { nodeId: ev.nodeId, attempt: ev.attempt };
    case "node_completed":
      return { nodeId: ev.nodeId, cached: ev.cached, ok: ev.output.ok, durationMs: ev.durationMs };
    case "node_failed":
      return { nodeId: ev.nodeId, retriable: ev.error.retriable, willRetry: ev.willRetry };
    case "human_gate_reached":
      return { nodeId: ev.nodeId, resumeToken: ev.resumeToken };
    case "flow_completed":
      return {
        status: ev.status,
        totalCostUsd: ev.totalCostUsd,
        costConfidence: ev.costConfidence,
        nodeCount: ev.nodeCount,
      };
  }
}
