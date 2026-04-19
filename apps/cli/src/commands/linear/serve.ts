/**
 * `shamu linear serve` — long-lived daemon that runs the canonical flow
 * against `shamu:ready` Linear issues.
 *
 * Composition: wires `@shamu/linear-webhook`'s receiver + the runtime in
 * `apps/cli/src/services/linear-runtime.ts` + the shared run DB. Env
 * resolution follows the `linear tunnel` precedent (arg → env → default,
 * missing-required fails USAGE).
 *
 * Lifecycle (Phase 8.A drain semantics):
 *   - First SIGINT / SIGTERM triggers `runtime.drainAndStop(drainMs)`.
 *     Pickups stop; in-flight runs continue until they finish or the
 *     deadline trips. Rolling comments on in-flight issues get a drain
 *     banner so operators can tell the daemon is shutting down cleanly.
 *   - Second SIGINT / SIGTERM forces an immediate cancel
 *     (`runtime.drainAndStop(0)`) — every in-flight AbortController
 *     fires, issues flip to `shamu:blocked` with a drain reason, and
 *     the daemon exits as soon as the label-flip path settles.
 *   - Clean shutdown returns `ExitCode.OK`.
 *   - Boot failures (missing creds, missing label, boot-time Linear
 *     error) return `ExitCode.USAGE` when operator-fixable and
 *     `ExitCode.INTERNAL` otherwise.
 */

import { dirname } from "node:path";
import { LinearClient, resolveLinearApiKey } from "@shamu/linear-client";
import {
  createWebhookServer,
  DEFAULT_HOST,
  DEFAULT_PORT,
  ENV_HOST,
  ENV_PORT,
  type WebhookServerHandle,
} from "@shamu/linear-webhook";
import type { ShamuDatabase } from "@shamu/persistence";
import { defineCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "../../exit-codes.ts";
import { writeDiag, writeHuman, writeJson } from "../../output.ts";
import { createLinearRuntime, type LinearRuntimeHandle } from "../../services/linear-runtime.ts";
import { openRunDatabase } from "../../services/run-db.ts";
import { commonArgs, done, outputMode, withServices } from "../_shared.ts";

const ENV_TEAM_ID = "LINEAR_TEAM_ID" as const;
const ENV_WEBHOOK_SECRET = "LINEAR_WEBHOOK_SECRET" as const;
const ENV_FLOW_MODULE = "SHAMU_LINEAR_FLOW_MODULE" as const;
const ENV_DRAIN_TIMEOUT = "SHAMU_DRAIN_TIMEOUT" as const;
const DEFAULT_DRAIN_TIMEOUT_SECONDS = 600;

/**
 * Resolve an arg OR env value; returns `null` when neither is present.
 * Callers translate `null` into the appropriate USAGE error.
 */
function resolveStringOption(explicit: string | undefined, envName: string): string | null {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return null;
}

function resolvePort(explicit: string | undefined): number {
  if (explicit !== undefined && explicit.length > 0) {
    const parsed = Number.parseInt(explicit, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  const env = process.env[ENV_PORT];
  if (env && env.length > 0) {
    const parsed = Number.parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_PORT;
}

function resolveHost(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const env = process.env[ENV_HOST];
  if (env && env.length > 0) return env;
  return DEFAULT_HOST;
}

/**
 * Resolve the drain timeout in MS. Accepts decimal seconds from CLI /
 * env; falls back to the 600s default. Non-positive values clamp to 0
 * (forces immediate cancel on first signal).
 */
function resolveDrainTimeoutMs(explicit: string | undefined): number {
  const raw =
    explicit !== undefined && explicit.length > 0 ? explicit : process.env[ENV_DRAIN_TIMEOUT];
  let seconds = DEFAULT_DRAIN_TIMEOUT_SECONDS;
  if (raw !== undefined && raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) seconds = parsed;
  }
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.floor(seconds * 1000);
}

export const linearServeCommand = defineCommand({
  meta: {
    name: "serve",
    description:
      "Run the Linear daemon: picks up shamu:ready issues, runs the canonical flow, updates labels + comments (Phase 6.C).",
  },
  args: {
    ...commonArgs,
    "team-id": {
      type: "string",
      description: "Linear team id. Default: $LINEAR_TEAM_ID.",
    },
    "webhook-port": {
      type: "string",
      description: "Port for the webhook receiver (default: 7357 or $SHAMU_LINEAR_WEBHOOK_PORT).",
    },
    "webhook-host": {
      type: "string",
      description: "Host to bind (default: 127.0.0.1 or $SHAMU_LINEAR_WEBHOOK_HOST).",
    },
    "webhook-secret": {
      type: "string",
      description:
        "HMAC secret for webhook signature verification. Default: $LINEAR_WEBHOOK_SECRET (required).",
    },
    "flow-module": {
      type: "string",
      description:
        "Flow module spec (default: @shamu/flows-plan-execute-review). May be a package name OR an absolute path to a .ts/.js file. NOTE: when a path is used, Bun's ESM loader resolves bare specifiers (including @shamu/*) from the module's own directory; modules that live OUTSIDE a workspace package's tree will transparently fall back to a shim in the CLI's own node_modules scope — the fallback works for flows that import only shamu packages, but we still recommend placing user-authored flows under a workspace package tree.",
    },
    cwd: {
      type: "string",
      description: "Workspace cwd passed to the flow (default: process.cwd()).",
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
    "drain-timeout": {
      type: "string",
      description:
        "Seconds to wait for in-flight runs to finish after the first SIGINT/SIGTERM (default 600, or $SHAMU_DRAIN_TIMEOUT). A second signal forces an immediate cancel.",
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    const teamId = resolveStringOption(args["team-id"] as string | undefined, ENV_TEAM_ID);
    if (teamId === null) {
      writeDiag(
        "linear serve: --team-id or $LINEAR_TEAM_ID is required (resolve via `shamu doctor`).",
      );
      return done(ExitCode.USAGE);
    }

    const webhookSecret = resolveStringOption(
      args["webhook-secret"] as string | undefined,
      ENV_WEBHOOK_SECRET,
    );
    if (webhookSecret === null) {
      writeDiag("linear serve: --webhook-secret or $LINEAR_WEBHOOK_SECRET is required.");
      return done(ExitCode.USAGE);
    }

    const webhookPort = resolvePort(args["webhook-port"] as string | undefined);
    const webhookHost = resolveHost(args["webhook-host"] as string | undefined);
    const flowModuleSpec =
      resolveStringOption(args["flow-module"] as string | undefined, ENV_FLOW_MODULE) ?? undefined;
    const workspaceCwd = (args.cwd as string | undefined) ?? process.cwd();

    // Resolve Linear API key. `resolveLinearApiKey` handles env-first +
    // credential-store fallback + non-fatal persist-back.
    const authRes = await resolveLinearApiKey({ env: process.env });
    if (!authRes.ok) {
      writeDiag(`linear serve: ${authRes.error.message}`);
      return done(ExitCode.CREDENTIALS_ERROR);
    }

    // Open run DB (daemon-owned; runtime never closes it).
    const dbPath = args.db as string | undefined;
    const stateDir = args["state-dir"] as string | undefined;
    let db: ShamuDatabase;
    try {
      if (dbPath !== undefined && dbPath.length > 0) {
        db = openRunDatabase({ stateDir: dirname(dbPath) });
      } else if (stateDir !== undefined && stateDir.length > 0) {
        db = openRunDatabase({ stateDir });
      } else {
        db = openRunDatabase();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`linear serve: failed to open SQLite database: ${message}`);
      return done(ExitCode.INTERNAL);
    }

    // Optional API URL override (test seam / self-host). See attach-pr
    // for the equivalent seam.
    const apiUrlOverride = process.env.SHAMU_LINEAR_API_URL;
    const client = new LinearClient({
      apiKey: authRes.value.apiKey,
      ...(apiUrlOverride && apiUrlOverride.length > 0 ? { apiUrl: apiUrlOverride } : {}),
    });

    // Start the webhook server before the runtime so the runtime's
    // `listLabels` call has a place to hand off once events arrive.
    let webhookServer: WebhookServerHandle;
    try {
      // Don't pass the CLI's stub logger — the webhook module wants
      // `@shamu/shared`'s Logger class shape; its default is fine here.
      webhookServer = createWebhookServer({
        secret: webhookSecret,
        port: webhookPort,
        host: webhookHost,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`linear serve: failed to start webhook server: ${message}`);
      try {
        db.close();
      } catch {
        // best-effort
      }
      return done(ExitCode.INTERNAL);
    }

    svc.services.logger.info("linear serve: webhook server listening", {
      host: webhookServer.host,
      port: webhookServer.port,
    });
    writeHuman(
      mode,
      `linear serve: webhook server listening on http://${webhookServer.host}:${webhookServer.port}/webhooks/linear`,
    );

    // Build the runtime. Boot failures (missing label, upstream error)
    // surface via `ready` rejection.
    //
    // After the Phase 6 stub-logger unification (HANDOFF 6.C.3 #3), the
    // CLI's `services.logger` IS the real `@shamu/shared/logger.Logger`,
    // so the integration primitives can take it directly — no need for a
    // second `createLogger` instance.
    const runtimeLogger = svc.services.logger.child({ component: "linear-runtime" });
    let runtime: LinearRuntimeHandle;
    try {
      runtime = await createLinearRuntime({
        client,
        teamId,
        webhookServer,
        db,
        logger: runtimeLogger,
        ...(flowModuleSpec !== undefined ? { flowModuleSpec } : {}),
        workspaceCwd,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`linear serve: failed to construct runtime: ${message}`);
      try {
        await webhookServer.stop();
      } catch {
        // best-effort
      }
      try {
        db.close();
      } catch {
        // best-effort
      }
      return done(ExitCode.INTERNAL);
    }

    try {
      await runtime.ready;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`linear serve: boot failed: ${message}`);
      try {
        await runtime.stop();
      } catch {
        // best-effort
      }
      try {
        db.close();
      } catch {
        // best-effort
      }
      return done(ExitCode.INTERNAL);
    }

    svc.services.logger.info("linear serve: runtime ready", { teamId });
    writeJson(mode, { kind: "linear-serve-ready", teamId });

    const drainTimeoutMs = resolveDrainTimeoutMs(args["drain-timeout"] as string | undefined);

    // Two-phase signal handling. First signal → drain (pause intake, let
    // in-flight runs finish up to `drainTimeoutMs`). Second signal →
    // force immediate cancel. Third signal → hard-exit, in case the
    // drain itself wedges.
    let shutdownCount = 0;
    const onSignal = (signal: NodeJS.Signals): void => {
      shutdownCount += 1;
      if (shutdownCount === 1) {
        svc.services.logger.info("linear serve: entering drain", {
          signal,
          drainTimeoutMs,
          inFlight: runtime.inFlight,
        });
        writeJson(mode, {
          kind: "linear-serve-drain-started",
          signal,
          drainTimeoutMs,
          inFlight: runtime.inFlight,
        });
        runtime.pause();
        void runtime.drainAndStop(drainTimeoutMs).catch((cause) => {
          svc.services.logger.error("linear serve: runtime.drainAndStop threw", {
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        });
        return;
      }
      if (shutdownCount === 2) {
        svc.services.logger.warn("linear serve: second signal; forcing immediate cancel", {
          signal,
        });
        writeJson(mode, { kind: "linear-serve-drain-forced", signal });
        void runtime.drainAndStop(0).catch(() => undefined);
        return;
      }
      svc.services.logger.warn("linear serve: third signal; hard exit", { signal });
      process.exit(ExitCode.INTERRUPTED);
    };
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGTERM", () => onSignal("SIGTERM"));

    try {
      await runtime.done;
      svc.services.logger.info("linear serve: runtime drained cleanly");
      writeJson(mode, { kind: "linear-serve-stopped" });
      return done(ExitCode.OK);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`linear serve: runtime exited with error: ${message}`);
      return done(ExitCode.INTERNAL);
    } finally {
      try {
        db.close();
      } catch {
        // best-effort
      }
    }
  },
});
