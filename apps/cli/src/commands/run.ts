/**
 * `shamu run` — start a new agent run.
 *
 * Phase 2.C scope:
 * - `--adapter <name>` spawns the matching adapter (`echo`, `claude`,
 *   `codex`), drives one turn with `--task <text>`, streams each event to
 *   stdout (human lines or `--json` NDJSON), and persists both the
 *   normalized projection and the raw payload to SQLite.
 * - Every `cost` event is stamped by the CORE with the authoritative
 *   `confidence` + `source` from the adapter's `costReporting` capability
 *   (T17). The adapter cannot self-certify cost.
 * - The vendor session id, when it first appears on an envelope, is
 *   persisted into `sessions` so `shamu resume` can warm-resume later.
 * - A `run-cost` summary is emitted at the end (human + JSON).
 * - SIGINT interrupts the handle cooperatively; after the handle drains we
 *   exit 13 (INTERRUPTED). A fatal `error` event exits 10 (RUN_FAILED).
 *   Normal `turn_end` exits 0.
 *
 * The orchestration is deliberately thin — a real supervisor lands in Phase
 * 3 — but the events written here are the same shape the supervisor will
 * write, so downstream consumers (TUI, dashboard) only wire up once.
 */

import type { SpawnOpts } from "@shamu/adapters-base";
import { runsQueries, type ShamuDatabase } from "@shamu/persistence";
import { newRunId } from "@shamu/shared";
import { defineCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "../exit-codes.ts";
import { modeFrom, writeDiag, writeHuman, writeJson } from "../output.ts";
import { isKnownAdapter, knownAdapterNames, loadAdapter } from "../services/adapters.ts";
import { resolveClaudeCliPath } from "../services/claude-sidecar-bootstrap.ts";
import { emitRunCostSummary } from "../services/run-cost.ts";
import { openRunDatabase } from "../services/run-db.ts";
import { streamHandle } from "../services/run-driver.ts";
import { commonArgs, done, outputMode, withServices } from "./_shared.ts";

export const runCommand = defineCommand({
  meta: {
    name: "run",
    description:
      "Start a new agent run. `--adapter <name>` selects the vendor (echo, claude, codex).",
  },
  args: {
    ...commonArgs,
    task: {
      type: "string",
      description: "Task description passed to the adapter as the first user turn.",
      required: true,
    },
    adapter: {
      type: "string",
      description: `Vendor adapter to use (one of: ${knownAdapterNames().join(", ")}).`,
    },
    role: {
      type: "string",
      description: "Role to run under (planner|executor|reviewer).",
      default: "executor",
    },
    "dry-run": {
      type: "boolean",
      description: "Validate inputs and exit without spawning anything.",
      default: false,
    },
    "state-dir": {
      type: "string",
      description:
        "Directory for the SQLite state file (overrides $SHAMU_STATE_DIR; default .shamu/state).",
    },
    "claude-cli": {
      type: "string",
      description:
        "Path to a pre-authenticated Claude CLI binary. Overrides $CLAUDE_CLI_PATH and skips the sidecar bootstrap. Only consulted when --adapter=claude.",
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    const rawAdapter = args.adapter ?? "";
    if (!rawAdapter) {
      writeDiag(
        `run: --adapter is required (known adapters: ${knownAdapterNames().join(", ")}; try --adapter echo for a smoke run)`,
      );
      return done(ExitCode.USAGE);
    }
    if (!isKnownAdapter(rawAdapter)) {
      writeDiag(`run: unknown adapter '${rawAdapter}' (known: ${knownAdapterNames().join(", ")})`);
      return done(ExitCode.USAGE);
    }

    svc.services.logger.info("run: accepted", {
      task: args.task,
      adapter: rawAdapter,
      role: args.role,
      dryRun: args["dry-run"],
    });

    if (args["dry-run"]) {
      writeJson(mode, {
        kind: "run-validated",
        task: args.task,
        adapter: rawAdapter,
        role: args.role,
      });
      writeHuman(mode, `run validated: adapter=${rawAdapter} role=${args.role}`);
      writeHuman(mode, `  task: ${args.task}`);
      return done(ExitCode.OK);
    }

    const stateDirArg = args["state-dir"];
    const stateDirOpt = stateDirArg ? { stateDir: stateDirArg } : {};
    let db: ShamuDatabase;
    try {
      db = openRunDatabase(stateDirOpt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`run: failed to open SQLite database: ${message}`);
      return done(ExitCode.INTERNAL);
    }

    try {
      const adapter = await loadAdapter(rawAdapter);
      // Phase 2+: the CLI (standing in for the Phase 3 supervisor) is the
      // authoritative source of `runId`. The adapter must adopt the id we
      // hand it via SpawnOpts — asserting equality here catches any vendor
      // adapter that tries to fabricate identity (G8 from threat model).
      const runId = newRunId();
      let resolvedClaudeCliPath: string | null = null;
      if (rawAdapter === "claude") {
        // Resolve the vendor CLI path via the precedence chain:
        //   --claude-cli > $CLAUDE_CLI_PATH > sidecar bootstrap > PATH.
        // We import `ensureClaudeSidecar` lazily so the Anthropic SDK's
        // module-init cost stays off the startup path for other adapters.
        const { ensureClaudeSidecar } = await import("@shamu/adapter-claude");
        const resolved = await resolveClaudeCliPath({
          ...(args["claude-cli"] ? { explicit: args["claude-cli"] } : {}),
          ensureSidecar: ensureClaudeSidecar,
          onSidecarError: (err) => {
            const message = err instanceof Error ? err.message : String(err);
            writeDiag(
              `run: claude sidecar bootstrap failed, falling back to PATH; error: ${message}`,
            );
          },
        });
        resolvedClaudeCliPath = resolved.path;
        svc.services.logger.info("run: resolved claude cli", {
          source: resolved.source,
          ...(resolved.path ? { path: resolved.path } : {}),
          ...(resolved.version ? { version: resolved.version } : {}),
        });
      }
      const spawnOpts: SpawnOpts = {
        cwd: process.cwd(),
        runId,
        ...(resolvedClaudeCliPath ? { vendorCliPath: resolvedClaudeCliPath } : {}),
      };
      const handle = await adapter.spawn(spawnOpts);
      if (handle.runId !== runId) {
        writeDiag(
          `run: adapter ${rawAdapter} returned handle.runId=${handle.runId} ` +
            `but was spawned with runId=${runId}; refusing to continue`,
        );
        await handle.shutdown("runid-mismatch");
        return done(ExitCode.INTERNAL);
      }
      runsQueries.insertRun(db, {
        runId,
        role: args.role,
        vendor: adapter.vendor,
        status: "running",
      });
      writeJson(mode, {
        kind: "run-started",
        runId,
        adapter: rawAdapter,
        role: args.role,
      });
      writeHuman(mode, `run ${runId} started (adapter=${rawAdapter} role=${args.role})`);

      await handle.send({ text: args.task });

      const exitCode = await streamHandle({
        adapter,
        handle,
        db,
        runId,
        mode,
      });

      // Final status projection from exit code.
      const terminal =
        exitCode === ExitCode.OK
          ? "completed"
          : exitCode === ExitCode.INTERRUPTED
            ? "failed"
            : "failed";
      runsQueries.updateRunStatus(db, runId, terminal);

      // One-shot run-cost summary so the operator sees what the run spent
      // without having to query the DB.
      emitRunCostSummary({
        db,
        runId,
        adapterName: adapter.vendor,
        role: args.role,
        mode,
      });

      await handle.shutdown("run-complete");
      return done(exitCode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`run: ${message}`);
      return done(ExitCode.INTERNAL);
    } finally {
      try {
        db.close();
      } catch {
        // best-effort close; errors here shouldn't mask the command result.
      }
    }
  },
});

/** Exposed so tests can mock output-mode resolution without re-parsing args. */
export const __testable = { modeFrom };
