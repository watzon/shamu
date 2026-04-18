/**
 * `shamu flow run <module-spec>` — execute a flow DAG module.
 *
 * Track 4.C glue between the 4.A flow engine and 4.B (or any externally
 * authored) flow module. The spec-form is deliberately permissive: a
 * bare workspace package name OR a path to a `.ts`/`.js` file.
 *
 * Phase 6.C.3: the engine-run core was extracted to
 * `apps/cli/src/services/flow-runner.ts` so the Linear daemon can reuse
 * it without forking a subprocess. This command handler retains every
 * external contract byte-identically:
 *
 *   - Mints a fresh WorkflowRunId if `--resume` is absent.
 *   - Persists `flow_runs` rows on every terminal / gate event.
 *   - JSON-mode emits newline-delimited events mirroring the bus.
 *   - Human mode emits one short summary line per event.
 *   - Exit codes: succeeded → 0, paused → 2 (USAGE), failed → 10
 *     (RUN_FAILED). Per Track 4.C.
 *   - `--resume <id>` loads the prior flow_runs row + threads state.
 *   - SIGINT / SIGTERM abort the run cleanly.
 */

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { FlowEvent } from "@shamu/core-flow";
import { EventBus } from "@shamu/core-flow";
import type { ShamuDatabase } from "@shamu/persistence";
import { workflowRunId as brandWorkflowRunId } from "@shamu/shared";
import { defineCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "../../exit-codes.ts";
import { writeDiag } from "../../output.ts";
import {
  FlowRunnerUsageError,
  type FlowTerminalStatus,
  runFlowInProcess,
} from "../../services/flow-runner.ts";
import { openRunDatabase } from "../../services/run-db.ts";
import { commonArgs, done, outputMode, withServices } from "../_shared.ts";

export const flowRunCommand = defineCommand({
  meta: {
    name: "run",
    description:
      "Run a flow module. <module-spec> is a package name (e.g. @shamu/flows-plan-execute-review) or a path to a .ts/.js file exporting flowDefinition + registerRunners. NOTE: when a path is used, Bun's ESM loader resolves bare specifiers from the module's own directory; flow modules outside any workspace package tree will fall back to a shim in the CLI's own node_modules scope (works when the module only imports @shamu/* packages).",
  },
  args: {
    ...commonArgs,
    "module-spec": {
      type: "positional",
      description: "Package name or path to the flow module.",
      required: true,
    },
    task: {
      type: "string",
      description: "Task description forwarded to the flow as initialInputs.task.",
      required: true,
    },
    cwd: {
      type: "string",
      description: "Workspace cwd passed to registerRunners (default: process.cwd()).",
    },
    "max-iterations": {
      type: "string",
      description:
        "Max iterations for loops / review cycles. Forwarded to parseOptions when present.",
    },
    "flow-opt": {
      type: "string",
      description:
        "Repeatable key=value option forwarded to the module's parseOptions(record). Example: --flow-opt plannerModel=gpt-5.4.",
    },
    resume: {
      type: "string",
      description: "Resume from a prior flow-run-id (loads state_json, passes as resumeFrom).",
    },
    db: {
      type: "string",
      description:
        "Override the SQLite path (advanced). Default: $SHAMU_STATE_DIR/shamu.db or .shamu/state/shamu.db.",
    },
    "state-dir": {
      type: "string",
      description:
        "Directory for the SQLite state file (overrides $SHAMU_STATE_DIR; default .shamu/state).",
    },
  },
  async run({ args, rawArgs }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    const spec = args["module-spec"];
    if (typeof spec !== "string" || spec.length === 0) {
      writeDiag("flow run: <module-spec> is required");
      return done(ExitCode.USAGE);
    }

    const task = args.task;
    if (typeof task !== "string" || task.length === 0) {
      writeDiag("flow run: --task is required and must be non-empty");
      return done(ExitCode.USAGE);
    }

    // --flow-opt is repeatable; citty collapses repeats into array or
    // scalar depending on invocation. `rawArgs` is the stable source.
    const flowOpts = collectFlowOpts(rawArgs);
    const workspaceCwd = (args.cwd as string | undefined) ?? process.cwd();

    const maxIterationsRaw = args["max-iterations"];
    const maxIterationsParsed = parseMaxIterations(maxIterationsRaw);
    if (maxIterationsParsed.kind === "error") {
      writeDiag(`flow run: ${maxIterationsParsed.message}`);
      return done(ExitCode.USAGE);
    }

    // Open the DB first — want a clean USAGE exit if the state dir can't
    // be created, without having loaded the flow module.
    const dbPath = args.db as string | undefined;
    const stateDir = args["state-dir"] as string | undefined;
    let db: ShamuDatabase;
    try {
      if (dbPath !== undefined && dbPath.length > 0) {
        db = openRunDatabase({ stateDir: absoluteParent(dbPath) });
      } else if (stateDir !== undefined && stateDir.length > 0) {
        db = openRunDatabase({ stateDir });
      } else {
        db = openRunDatabase();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`flow run: failed to open SQLite database: ${message}`);
      return done(ExitCode.INTERNAL);
    }

    const logger = svc.services.logger;
    const resumeArg = args.resume as string | undefined;
    const resumeFlowRunId =
      resumeArg !== undefined && resumeArg.length > 0 ? brandWorkflowRunId(resumeArg) : null;

    // Command handler owns the bus + SIGINT/SIGTERM wiring; the service
    // just wires its own sinks onto whatever bus the caller hands it.
    const bus = new EventBus<FlowEvent>();
    const controller = new AbortController();
    const onSigint = (): void => controller.abort();
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigint);

    try {
      const outcome = await runFlowInProcess({
        moduleSpec: spec,
        task,
        workspaceCwd,
        flowOpts,
        maxIterations: maxIterationsParsed.value,
        resumeFlowRunId,
        db,
        logger,
        flowBus: bus,
        signal: controller.signal,
        outputMode: mode,
      });
      return done(exitCodeFor(outcome.status));
    } catch (err) {
      if (err instanceof FlowRunnerUsageError) {
        writeDiag(`flow run: ${err.message}`);
        return done(ExitCode.USAGE);
      }
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`flow run: ${message}`);
      return done(ExitCode.INTERNAL);
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigint);
      try {
        db.close();
      } catch {
        // best-effort close
      }
    }
  },
});

// --- Helpers ---------------------------------------------------------------

interface MaxIterationsOk {
  readonly kind: "ok";
  readonly value: number | null;
}
interface MaxIterationsErr {
  readonly kind: "error";
  readonly message: string;
}
type MaxIterationsResult = MaxIterationsOk | MaxIterationsErr;

function parseMaxIterations(raw: string | undefined): MaxIterationsResult {
  if (raw === undefined || raw === "") return { kind: "ok", value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return {
      kind: "error",
      message: `--max-iterations must be a positive integer, got '${raw}'`,
    };
  }
  return { kind: "ok", value: n };
}

/**
 * Scan rawArgs for every `--flow-opt key=value` pair. citty collapses
 * repeated flags; rawArgs is the stable source of truth.
 */
function collectFlowOpts(rawArgs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--flow-opt") {
      const next = rawArgs[i + 1];
      if (typeof next === "string") {
        const eq = next.indexOf("=");
        if (eq > 0) {
          const key = next.slice(0, eq);
          const value = next.slice(eq + 1);
          out[key] = value;
        }
        i++;
      }
    } else if (typeof arg === "string" && arg.startsWith("--flow-opt=")) {
      const body = arg.slice("--flow-opt=".length);
      const eq = body.indexOf("=");
      if (eq > 0) {
        out[body.slice(0, eq)] = body.slice(eq + 1);
      }
    }
  }
  return out;
}

function exitCodeFor(status: FlowTerminalStatus): ExitCodeValue {
  if (status === "succeeded") return ExitCode.OK;
  if (status === "paused") return ExitCode.USAGE;
  return ExitCode.RUN_FAILED;
}

/**
 * If `--db` points at a specific file, open via `openRunDatabase(stateDir)`
 * where stateDir is the parent dir. Callers without `--db` never reach here.
 */
function absoluteParent(path: string): string {
  const abs = resolvePath(path);
  if (!existsSync(abs)) {
    const lastSlash = abs.lastIndexOf("/");
    if (lastSlash < 0) return process.cwd();
    return abs.slice(0, lastSlash);
  }
  const lastSlash = abs.lastIndexOf("/");
  if (lastSlash < 0) return process.cwd();
  return abs.slice(0, lastSlash);
}
