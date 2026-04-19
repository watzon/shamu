/**
 * `shamu run` — start a new agent run.
 *
 * Phase 2.C → Phase 9.A:
 * - `--adapter <name>` spawns the matching adapter. Uniform
 *   `--<vendor>-cli <path>` flags (Phase 9.A) override the resolver's
 *   first candidate per adapter; `--model <name>` threads into
 *   `SpawnOpts.model`.
 * - Every vendor CLI path goes through `resolveVendorCli` from
 *   `@shamu/adapters-base/vendor-cli-resolver`. Echo short-circuits
 *   with "no binary required"; Claude adds a `lastChance` hook that
 *   delegates to `ensureClaudeSidecar()` when every on-disk candidate
 *   misses.
 * - Every `cost` event is stamped by the CORE with the authoritative
 *   `confidence` + `source` from the adapter's `costReporting`
 *   capability (T17). The adapter cannot self-certify cost.
 * - The vendor session id, when it first appears on an envelope, is
 *   persisted into `sessions` so `shamu resume` can warm-resume later.
 * - A `run-cost` summary is emitted at the end.
 * - SIGINT interrupts the handle cooperatively; after the handle
 *   drains we exit 13 (INTERRUPTED). A fatal `error` event exits 10
 *   (RUN_FAILED). Normal `turn_end` exits 0.
 */

import type { SpawnOpts } from "@shamu/adapters-base";
import {
  resolveVendorCli,
  type VendorCliResolverResult,
} from "@shamu/adapters-base/vendor-cli-resolver";
import { runsQueries, type ShamuDatabase } from "@shamu/persistence";
import { newRunId } from "@shamu/shared";
import { defineCommand } from "citty";
import { type AdapterConfigEntry, loadConfig } from "../config.ts";
import { ExitCode, type ExitCodeValue } from "../exit-codes.ts";
import { modeFrom, writeDiag, writeHuman, writeJson } from "../output.ts";
import {
  type AdapterName,
  adapterHasVendorCli,
  isKnownAdapter,
  knownAdapterNames,
  loadAdapter,
} from "../services/adapters.ts";
import { buildClaudeLastChance } from "../services/claude-sidecar-bootstrap.ts";
import { emitRunCostSummary } from "../services/run-cost.ts";
import { openRunDatabase } from "../services/run-db.ts";
import { streamHandle } from "../services/run-driver.ts";
import { getVendorCliDescriptor } from "../services/vendor-cli-registry.ts";
import { commonArgs, done, outputMode, withServices } from "./_shared.ts";

/** Map of `--<vendor>-cli` flag value per adapter. */
type VendorCliArgs = Partial<Record<AdapterName, string>>;

export const runCommand = defineCommand({
  meta: {
    name: "run",
    description: `Start a new agent run. \`--adapter <name>\` selects the vendor (${knownAdapterNames().join(", ")}).`,
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
    model: {
      type: "string",
      description:
        "Model name passed via SpawnOpts.model. Beats shamu.config.ts adapters.<vendor>.defaultModel; falls back to adapter default when unset.",
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
    // Uniform vendor-CLI flags. Feed `explicit` into resolveVendorCli for
    // the chosen adapter. Per PLAN 9.A: keep `--claude-cli` (promoted
    // case, don't rename) and add sibling flags for every other adapter
    // with a real vendor CLI.
    "claude-cli": {
      type: "string",
      description:
        "Path to a pre-authenticated Claude CLI binary (only consulted when --adapter=claude).",
    },
    "codex-cli": {
      type: "string",
      description:
        "Path to a pre-authenticated Codex CLI binary (only consulted when --adapter=codex).",
    },
    "cursor-cli": {
      type: "string",
      description: "Path to the Cursor agent binary (only consulted when --adapter=cursor).",
    },
    "gemini-cli": {
      type: "string",
      description: "Path to the Gemini CLI binary (only consulted when --adapter=gemini).",
    },
    "amp-cli": {
      type: "string",
      description: "Path to the Amp CLI binary (only consulted when --adapter=amp).",
    },
    "opencode-cli": {
      type: "string",
      description: "Path to the OpenCode binary (only consulted when --adapter=opencode).",
    },
    "pi-cli": {
      type: "string",
      description: "Path to the Pi CLI binary (only consulted when --adapter=pi).",
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

    const vendorCliArgs: VendorCliArgs = {
      claude: args["claude-cli"],
      codex: args["codex-cli"],
      cursor: args["cursor-cli"],
      gemini: args["gemini-cli"],
      amp: args["amp-cli"],
      opencode: args["opencode-cli"],
      pi: args["pi-cli"],
    };

    // Load shamu.config.ts — adapters.<vendor> may pin cliPath /
    // defaultModel / version constraint. Missing file is OK.
    const configParams: Parameters<typeof loadConfig>[0] = {};
    if (args.config !== undefined) configParams.explicitPath = args.config;
    const configResult = await loadConfig(configParams);
    if (!configResult.ok) {
      writeDiag(`run: config error: ${configResult.error.message}`);
      return done(ExitCode.USAGE);
    }
    const adapterConfig = configResult.value.adapters[rawAdapter];

    // Model precedence: --model flag > shamu.config.ts defaultModel >
    // adapter's hard-coded default (handled by the adapter itself).
    const resolvedModel =
      typeof args.model === "string" && args.model.length > 0
        ? args.model
        : adapterConfig?.defaultModel;

    svc.services.logger.info("run: accepted", {
      task: args.task,
      adapter: rawAdapter,
      role: args.role,
      dryRun: args["dry-run"],
      ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
    });

    // Resolve the vendor CLI path before the subprocess work. Failures
    // here are structured (`VendorCliNotFoundError` /
    // `VendorCliVersionMismatchError`) and mapped to USAGE so the
    // operator sees the candidate list.
    let cliResolution: VendorCliResolverResult;
    try {
      cliResolution = await resolveVendorCliForRun({
        adapter: rawAdapter,
        explicit: vendorCliArgs[rawAdapter],
        configEntry: adapterConfig,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`run: ${message}`);
      return done(ExitCode.USAGE);
    }

    if (args["dry-run"]) {
      writeJson(mode, {
        kind: "run-validated",
        task: args.task,
        adapter: rawAdapter,
        role: args.role,
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        cli: {
          source: cliResolution.source,
          ...(cliResolution.path.length > 0 ? { path: cliResolution.path } : {}),
          ...(cliResolution.version !== undefined ? { version: cliResolution.version } : {}),
        },
      });
      writeHuman(mode, `run validated: adapter=${rawAdapter} role=${args.role}`);
      writeHuman(mode, `  task: ${args.task}`);
      if (resolvedModel !== undefined) writeHuman(mode, `  model: ${resolvedModel}`);
      if (cliResolution.source !== "unused") {
        writeHuman(
          mode,
          `  cli: ${cliResolution.path} (source=${cliResolution.source}${cliResolution.version ? `, version=${cliResolution.version}` : ""})`,
        );
      }
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
      svc.services.logger.info("run: resolved vendor cli", {
        adapter: rawAdapter,
        source: cliResolution.source,
        ...(cliResolution.path.length > 0 ? { path: cliResolution.path } : {}),
        ...(cliResolution.version ? { version: cliResolution.version } : {}),
      });
      const spawnOpts: SpawnOpts = {
        cwd: process.cwd(),
        runId,
        ...(cliResolution.path.length > 0 ? { vendorCliPath: cliResolution.path } : {}),
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        ...(adapterConfig?.envOverrides !== undefined ? { env: adapterConfig.envOverrides } : {}),
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

/**
 * Build the `lastChance` hook for Claude (sidecar bootstrap). Every other
 * adapter passes `undefined`. Import of the Claude SDK is lazy so echo /
 * codex / … runs don't pay the Anthropic SDK's module-init cost.
 */
async function claudeLastChance(
  writeSidecarDiag: (msg: string) => void,
): Promise<() => Promise<string | null>> {
  const { ensureClaudeSidecar } = await import("@shamu/adapter-claude");
  return buildClaudeLastChance({
    ensureSidecar: ensureClaudeSidecar,
    onSidecarError: (err) => {
      const message = err instanceof Error ? err.message : String(err);
      writeSidecarDiag(
        `claude sidecar bootstrap failed; falling through to resolver error: ${message}`,
      );
    },
  });
}

/** Wrap `resolveVendorCli` with the Claude-specific lastChance hook. */
async function resolveVendorCliForRun(params: {
  readonly adapter: AdapterName;
  readonly explicit: string | undefined;
  readonly configEntry: AdapterConfigEntry | undefined;
}): Promise<VendorCliResolverResult> {
  const descriptor = getVendorCliDescriptor(params.adapter);
  const configEntry = narrowConfigEntry(params.configEntry);
  if (!adapterHasVendorCli(params.adapter)) {
    // Short-circuit echo without going through the resolver's
    // "isNoBinaryDescriptor" branch — yields the same result. Kept
    // explicit here to make the CLI flow read clearly.
    return resolveVendorCli({
      adapter: params.adapter,
      descriptor,
      ...(params.explicit !== undefined ? { explicit: params.explicit } : {}),
      ...(configEntry !== undefined ? { configEntry } : {}),
    });
  }

  const lastChance = params.adapter === "claude" ? await claudeLastChance(writeDiag) : undefined;

  return resolveVendorCli({
    adapter: params.adapter,
    descriptor,
    ...(params.explicit !== undefined ? { explicit: params.explicit } : {}),
    ...(configEntry !== undefined ? { configEntry } : {}),
    ...(lastChance !== undefined ? { lastChance } : {}),
  });
}

/**
 * Convert the AdapterConfigEntry (with its optional-or-undefined fields)
 * into the narrow shape the resolver accepts under
 * `exactOptionalPropertyTypes`. Returns undefined when the entry carries
 * no resolver-relevant fields.
 */
function narrowConfigEntry(
  entry: AdapterConfigEntry | undefined,
): { cliPath?: string; cliVersionConstraint?: string } | undefined {
  if (entry === undefined) return undefined;
  const out: { cliPath?: string; cliVersionConstraint?: string } = {};
  if (entry.cliPath !== undefined) out.cliPath = entry.cliPath;
  if (entry.cliVersionConstraint !== undefined) {
    out.cliVersionConstraint = entry.cliVersionConstraint;
  }
  return out;
}

/** Exposed so tests can mock output-mode resolution without re-parsing args. */
export const __testable = { modeFrom };
