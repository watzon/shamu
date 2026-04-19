/**
 * `shamu ui` — open the local web dashboard in the default browser.
 *
 * Boots `@shamu/web`'s HTTP server in-process, prints a banner (or JSON
 * event), optionally spawns the OS browser, and stays alive until
 * SIGINT/SIGTERM. This command is Phase 8.C's CLI wiring for the MVP
 * dashboard landed in #25.
 *
 * Lifecycle:
 *   - `startServer()` from `@shamu/web` returns `{ url, stop, config }`.
 *   - We register SIGINT/SIGTERM handlers that call `stop()`, then resolve
 *     the command's promise. The command's exit code is ExitCode.OK on a
 *     clean shutdown; ExitCode.INTERNAL if the boot itself throws.
 *   - The browser launch is best-effort: `open` on darwin, `xdg-open` on
 *     linux, otherwise a "please open <url> manually" diag. Detached +
 *     unref'd so the CLI doesn't wait on the GUI.
 */

import { spawn } from "node:child_process";
import { openDatabase, runsQueries } from "@shamu/persistence";
import { startServer } from "@shamu/web";
import { defineCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "../exit-codes.ts";
import { writeDiag, writeHuman, writeJson } from "../output.ts";
import { commonArgs, done, outputMode, withServices } from "./_shared.ts";

export const uiCommand = defineCommand({
  meta: {
    name: "ui",
    description: "Open the local web dashboard in the default browser.",
  },
  args: {
    ...commonArgs,
    port: {
      type: "string",
      description: "Dashboard port (overrides $SHAMU_WEB_PORT; defaults to the server's 4711).",
    },
    "no-open": {
      type: "boolean",
      description: "Print the URL instead of launching a browser.",
      default: false,
    },
    "unsafe-bind": {
      type: "string",
      description:
        "Bind to an address other than 127.0.0.1. Documentation-only in v1: the server always binds loopback.",
    },
    "state-dir": {
      type: "string",
      description:
        "Directory for the SQLite state file (overrides $SHAMU_STATE_DIR; default .shamu/state).",
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    // `--unsafe-bind` is wired as documentation for now — the server binds to
    // 127.0.0.1 unconditionally (see ServerConfig.host). We still fire the
    // warning so users don't silently think the flag took effect.
    const unsafeBind = args["unsafe-bind"];
    if (unsafeBind !== undefined) {
      process.stderr.write(
        `\n  WARNING: --unsafe-bind=${unsafeBind} is accepted but not yet honored.\n` +
          "  The dashboard binds to 127.0.0.1 in v1; non-loopback support ships with auth in Phase 8.C.\n\n",
      );
      svc.services.logger.warn("ui: unsafe-bind requested but ignored in v1", {
        bind: unsafeBind,
      });
    }

    // Port flag overrides $SHAMU_WEB_PORT; passed through to resolveConfig().
    const portArg = args.port;
    let port: number | undefined;
    if (portArg !== undefined && portArg !== "") {
      const parsed = Number.parseInt(portArg, 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
        writeDiag(`ui: --port must be an integer in [1, 65535]; got ${portArg}`);
        return done(ExitCode.USAGE);
      }
      port = parsed;
    }

    const stateDirArg = args["state-dir"];
    const startOpts: Parameters<typeof startServer>[0] = {
      ...(port !== undefined ? { port } : {}),
      ...(stateDirArg !== undefined && stateDirArg !== "" ? { stateDir: stateDirArg } : {}),
    };

    let handle: Awaited<ReturnType<typeof startServer>>;
    try {
      handle = await startServer(startOpts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`ui: failed to start web server: ${message}`);
      return done(ExitCode.INTERNAL);
    }

    const { url, config, stop } = handle;

    // Register signal handlers BEFORE we print the banner. Otherwise a caller
    // that kills the process immediately after seeing our startup line (the
    // ui.test.ts subprocess harness does exactly this) can race with our
    // handler-setup and hit Node's default SIGTERM handler (which exits
    // via signal rather than letting us run `stop()`).
    const shutdown = waitForShutdown(stop);

    if (mode === "json") {
      writeJson(mode, {
        kind: "ui-started",
        url,
        port: config.port,
        host: config.host,
      });
    } else {
      writeHuman(mode, `shamu ui listening at ${url}`);
      writeHuman(mode, `  db:        ${config.dbPath}`);
      writeHuman(mode, `  staticDir: ${config.staticDir}`);
    }

    // Phase 9.C: when the local DB has zero runs, the dashboard's default
    // `/` page is a "no runs yet" empty state — not very useful for a
    // first-time user. Point them straight at `/new-run` so they can
    // kick off a swarm without hunting for the form. Falls back to `/`
    // when there's any run history.
    const entryPath = hasAnyRuns(config.dbPath) ? "/" : "/new-run";
    const entryUrl = `${url}${entryPath}`;

    if (!args["no-open"]) {
      launchBrowser(entryUrl, mode);
    } else if (mode === "human") {
      writeHuman(mode, `  (--no-open set; open ${entryUrl} manually)`);
    }

    // Stay alive until a signal arrives. The returned promise resolves with
    // ExitCode.OK after `stop()` completes.
    return await shutdown;
  },
});

/**
 * Best-effort probe: does the local DB have any rows in `runs`? Used by
 * `ui` to decide whether to auto-open `/new-run` (empty DB) or `/`
 * (pre-existing history). Any error is treated as "there may be runs" —
 * we'd rather land on the overview and let the user navigate than flash a
 * new-run page over the top of their existing history.
 */
function hasAnyRuns(dbPath: string): boolean {
  try {
    const db = openDatabase(dbPath);
    try {
      const rows = runsQueries.listRuns(db);
      return rows.length > 0;
    } finally {
      try {
        db.close();
      } catch {
        /* best-effort */
      }
    }
  } catch {
    return true;
  }
}

/**
 * Best-effort OS browser launch. Uses `open` on darwin, `xdg-open` on linux,
 * and prints a manual-open diag on other platforms. The child is detached +
 * unref'd so the CLI's shutdown isn't held up by the GUI process.
 */
function launchBrowser(url: string, mode: "human" | "json"): void {
  const platform = process.platform;
  let cmd: string | null = null;
  if (platform === "darwin") cmd = "open";
  else if (platform === "linux") cmd = "xdg-open";

  if (cmd === null) {
    const message = `ui: browser auto-launch unsupported on ${platform}; open ${url} manually`;
    if (mode === "human") writeDiag(message);
    return;
  }

  try {
    const child = spawn(cmd, [url], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      writeDiag(`ui: failed to launch browser (${cmd}): ${err.message}; open ${url} manually`);
    });
    child.unref();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeDiag(`ui: failed to launch browser (${cmd}): ${message}; open ${url} manually`);
  }
}

/**
 * Resolve when SIGINT or SIGTERM arrives. Calls `stop()` on the server
 * handle, then records ExitCode.OK.
 */
function waitForShutdown(stop: () => Promise<void>): Promise<ExitCodeValue> {
  return new Promise((resolve) => {
    let firing = false;
    const handle = (signal: NodeJS.Signals) => {
      if (firing) return;
      firing = true;
      writeDiag(`ui: received ${signal}; shutting down`);
      process.off("SIGINT", handle);
      process.off("SIGTERM", handle);
      void stop().finally(() => {
        resolve(done(ExitCode.OK));
      });
    };
    process.on("SIGINT", handle);
    process.on("SIGTERM", handle);
  });
}
