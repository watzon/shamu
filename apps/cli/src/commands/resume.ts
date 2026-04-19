/**
 * `shamu resume <run-id> --task <text>` — warm-resume a previously-created
 * run.
 *
 * Resume is a NEW shamu-local run (supervisor is the authority over runIds,
 * G8 — we never reuse the source run's id). The vendor session id we carry
 * forward is the one persisted by the previous run; the new runId owns the
 * fresh events, the fresh cost summary, and any new session ids the vendor
 * chooses to assign (some vendors expire old sessions and mint a new one on
 * resume — we record that too).
 *
 * Flow:
 *   1. Open the CLI database.
 *   2. `runsQueries.getRun` — 404 if the id is unknown.
 *   3. `sessionsQueries.getSessionByRunId` — 400 if the original run never
 *      produced a session.
 *   4. Pick the adapter: defaults to `session.vendor`; `--adapter` override
 *      must match or we reject.
 *   5. Resolve the vendor CLI via the shared `resolveVendorCli` chain
 *      (Phase 9.A) — uniform flags, env, config, per-adapter candidates.
 *   6. Mint a fresh runId, insert a new `runs` row.
 *   7. `adapter.resume(session.sessionId, { runId: newRunId, model?, ... })`.
 *   8. Drive one user turn with `--task`.
 *   9. Stream events through the shared driver (same cost-stamping +
 *      session-persisting logic as `shamu run`).
 *  10. Emit a `run-cost` summary.
 */

import type { SpawnOpts } from "@shamu/adapters-base";
import {
  resolveVendorCli,
  type VendorCliResolverResult,
} from "@shamu/adapters-base/vendor-cli-resolver";
import { runsQueries, type ShamuDatabase, sessionsQueries } from "@shamu/persistence";
import { runId as brandRunId, newRunId } from "@shamu/shared";
import { defineCommand } from "citty";
import { type AdapterConfigEntry, loadConfig } from "../config.ts";
import { ExitCode, type ExitCodeValue } from "../exit-codes.ts";
import { writeDiag, writeHuman, writeJson } from "../output.ts";
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

export const resumeCommand = defineCommand({
  meta: {
    name: "resume",
    description: "Resume a previously-started run by id (cache-warm follow-up turn).",
  },
  args: {
    ...commonArgs,
    "run-id": {
      type: "positional",
      description: "Run id of the original run to resume.",
      required: true,
    },
    task: {
      type: "string",
      description: "Task description passed as the follow-up user turn.",
      required: true,
    },
    adapter: {
      type: "string",
      description: `Override the adapter. Must match the session's vendor (known: ${knownAdapterNames().join(", ")}).`,
    },
    model: {
      type: "string",
      description:
        "Model name passed via SpawnOpts.model. Beats shamu.config.ts adapters.<vendor>.defaultModel.",
    },
    "state-dir": {
      type: "string",
      description:
        "Directory for the SQLite state file (overrides $SHAMU_STATE_DIR; default .shamu/state).",
    },
    "claude-cli": { type: "string", description: "Path to the Claude CLI binary." },
    "codex-cli": { type: "string", description: "Path to the Codex CLI binary." },
    "cursor-cli": { type: "string", description: "Path to the Cursor agent binary." },
    "gemini-cli": { type: "string", description: "Path to the Gemini CLI binary." },
    "amp-cli": { type: "string", description: "Path to the Amp CLI binary." },
    "opencode-cli": { type: "string", description: "Path to the OpenCode binary." },
    "pi-cli": { type: "string", description: "Path to the Pi CLI binary." },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    svc.services.logger.info("resume: accepted", { runId: args["run-id"] });

    const originalRunIdRaw = args["run-id"];
    if (typeof originalRunIdRaw !== "string" || originalRunIdRaw.length === 0) {
      writeDiag("resume: <run-id> is required");
      return done(ExitCode.USAGE);
    }
    const originalRunId = brandRunId(originalRunIdRaw);

    const stateDirArg = args["state-dir"];
    const stateDirOpt = stateDirArg ? { stateDir: stateDirArg } : {};
    let db: ShamuDatabase;
    try {
      db = openRunDatabase(stateDirOpt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`resume: failed to open SQLite database: ${message}`);
      return done(ExitCode.INTERNAL);
    }

    try {
      const originalRun = runsQueries.getRun(db, originalRunId);
      if (!originalRun) {
        writeJson(mode, {
          kind: "error",
          category: "not-found",
          message: `run ${originalRunId} not found`,
        });
        writeDiag(`resume: run ${originalRunId} not found`);
        return done(ExitCode.USAGE);
      }

      const session = sessionsQueries.getSessionByRunId(db, originalRunId);
      if (!session) {
        writeJson(mode, {
          kind: "error",
          category: "no-session",
          message: `run ${originalRunId} never produced a vendor session; nothing to resume`,
        });
        writeDiag(
          `resume: run ${originalRunId} has no persisted session id; cannot resume (original run may have failed before session_start)`,
        );
        return done(ExitCode.USAGE);
      }

      // Adapter resolution: the session's vendor is authoritative. If the
      // caller passed `--adapter` we accept it only when it agrees — a
      // mismatch would try to drive a Claude session through the Codex SDK.
      const overrideAdapterRaw = args.adapter;
      const resolvedAdapterName = overrideAdapterRaw ? overrideAdapterRaw : session.vendor;
      if (!isKnownAdapter(resolvedAdapterName)) {
        writeDiag(
          `resume: unknown adapter '${resolvedAdapterName}' (known: ${knownAdapterNames().join(", ")})`,
        );
        return done(ExitCode.USAGE);
      }
      if (overrideAdapterRaw && overrideAdapterRaw !== session.vendor) {
        writeDiag(
          `resume: --adapter=${overrideAdapterRaw} does not match session vendor=${session.vendor}; refusing to cross vendors`,
        );
        return done(ExitCode.USAGE);
      }

      const adapter = await loadAdapter(resolvedAdapterName);
      if (!adapter.capabilities.resume) {
        writeDiag(
          `resume: adapter ${resolvedAdapterName} declares resume=false; cannot warm-start`,
        );
        return done(ExitCode.INTERNAL);
      }

      const vendorCliArgs: Partial<Record<AdapterName, string>> = {
        claude: args["claude-cli"],
        codex: args["codex-cli"],
        cursor: args["cursor-cli"],
        gemini: args["gemini-cli"],
        amp: args["amp-cli"],
        opencode: args["opencode-cli"],
        pi: args["pi-cli"],
      };

      const configParams: Parameters<typeof loadConfig>[0] = {};
      if (args.config !== undefined) configParams.explicitPath = args.config;
      const configResult = await loadConfig(configParams);
      if (!configResult.ok) {
        writeDiag(`resume: config error: ${configResult.error.message}`);
        return done(ExitCode.USAGE);
      }
      const adapterConfig = configResult.value.adapters[resolvedAdapterName];

      const resolvedModel =
        typeof args.model === "string" && args.model.length > 0
          ? args.model
          : adapterConfig?.defaultModel;

      let cliResolution: VendorCliResolverResult;
      try {
        cliResolution = await resolveVendorCliForResume({
          adapter: resolvedAdapterName,
          explicit: vendorCliArgs[resolvedAdapterName],
          configEntry: adapterConfig,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeDiag(`resume: ${message}`);
        return done(ExitCode.USAGE);
      }

      // Fresh runId per G8: the resumed run is a new run as far as the
      // orchestrator is concerned, even though it shares a vendor session
      // with the original. The sessions table links the two.
      const resumedRunId = newRunId();
      const role = originalRun.role ?? "executor";

      runsQueries.insertRun(db, {
        runId: resumedRunId,
        vendor: session.vendor,
        role,
        status: "running",
      });

      const resumeOpts: SpawnOpts = {
        cwd: process.cwd(),
        runId: resumedRunId,
        ...(cliResolution.path.length > 0 ? { vendorCliPath: cliResolution.path } : {}),
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        ...(adapterConfig?.envOverrides !== undefined ? { env: adapterConfig.envOverrides } : {}),
      };

      const handle = await adapter.resume(session.sessionId, resumeOpts);
      if (handle.runId !== resumedRunId) {
        writeDiag(
          `resume: adapter ${resolvedAdapterName} returned handle.runId=${handle.runId} ` +
            `but was resumed with runId=${resumedRunId}; refusing to continue`,
        );
        await handle.shutdown("runid-mismatch");
        return done(ExitCode.INTERNAL);
      }

      writeJson(mode, {
        kind: "run-resumed",
        originalRunId,
        runId: resumedRunId,
        adapter: resolvedAdapterName,
        role,
        sessionId: session.sessionId,
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        cli: {
          source: cliResolution.source,
          ...(cliResolution.path.length > 0 ? { path: cliResolution.path } : {}),
          ...(cliResolution.version !== undefined ? { version: cliResolution.version } : {}),
        },
      });
      writeHuman(
        mode,
        `run ${resumedRunId} resumed from ${originalRunId} ` +
          `(adapter=${resolvedAdapterName} role=${role} session=${session.sessionId})`,
      );

      // Note on session handling: if the vendor expired the original
      // session, a new `session_start` event will carry a fresh sessionId
      // which `streamHandle` will insert into the `sessions` table under
      // `resumedRunId`. The original (expired) session row stays in place
      // under `originalRunId` for audit.
      await handle.send({ text: args.task });

      const exitCode = await streamHandle({
        adapter,
        handle,
        db,
        runId: resumedRunId,
        mode,
      });

      const terminal = exitCode === ExitCode.OK ? "completed" : "failed";
      runsQueries.updateRunStatus(db, resumedRunId, terminal);

      emitRunCostSummary({
        db,
        runId: resumedRunId,
        adapterName: adapter.vendor,
        role,
        mode,
      });

      await handle.shutdown("resume-complete");
      return done(exitCode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`resume: ${message}`);
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

async function resolveVendorCliForResume(params: {
  readonly adapter: AdapterName;
  readonly explicit: string | undefined;
  readonly configEntry: AdapterConfigEntry | undefined;
}): Promise<VendorCliResolverResult> {
  const descriptor = getVendorCliDescriptor(params.adapter);
  const configEntry = narrowConfigEntry(params.configEntry);
  if (!adapterHasVendorCli(params.adapter)) {
    return resolveVendorCli({
      adapter: params.adapter,
      descriptor,
      ...(params.explicit !== undefined ? { explicit: params.explicit } : {}),
      ...(configEntry !== undefined ? { configEntry } : {}),
    });
  }
  let lastChance: (() => Promise<string | null>) | undefined;
  if (params.adapter === "claude") {
    const { ensureClaudeSidecar } = await import("@shamu/adapter-claude");
    lastChance = buildClaudeLastChance({
      ensureSidecar: ensureClaudeSidecar,
      onSidecarError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        writeDiag(
          `resume: claude sidecar bootstrap failed; falling through to resolver error: ${message}`,
        );
      },
    });
  }
  return resolveVendorCli({
    adapter: params.adapter,
    descriptor,
    ...(params.explicit !== undefined ? { explicit: params.explicit } : {}),
    ...(configEntry !== undefined ? { configEntry } : {}),
    ...(lastChance !== undefined ? { lastChance } : {}),
  });
}

/**
 * Convert the AdapterConfigEntry (optional-or-undefined fields) into the
 * resolver's narrow shape under `exactOptionalPropertyTypes`.
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
