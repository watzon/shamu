#!/usr/bin/env bun
/**
 * Capture PR-review screenshots of the `@shamu/web` dashboard.
 *
 * Phase 8.C.3 deliverable. Boots the web server against a seeded temp SQLite
 * DB, drives a headless browser through a small list of interesting routes,
 * and writes PNGs to an output directory. Emits NDJSON progress so the CI
 * workflow (and a dev running this locally) gets machine-readable output.
 *
 * Playwright without a workspace dep
 * ----------------------------------
 * Per track constraint, we MUST NOT add `playwright` / `@playwright/test` /
 * `puppeteer` as workspace deps. The GitHub Actions workflow runs
 * `bunx -y playwright@1.50.1 install --with-deps chromium` before invoking
 * this script so the binary cache is warm.
 *
 * Runtime invocation: we shell out to `npx -y -p playwright@<pin> node
 * <driver.mjs>` per screenshot. `npx -p <pkg>` installs the package into its
 * cache and drops its `node_modules` onto NODE_PATH for the subcommand —
 * which lets the driver `import("playwright")` at runtime without
 * `package.json` touching it.
 *
 * Exit codes:
 *   0  success
 *   2  Playwright's Chromium isn't installed (soft-fail for local dev)
 *  10  server boot failure (DB open, port bind, etc.)
 *  20  screenshot failure (navigation timeout, browser crash, etc.)
 *  64  bad CLI arguments (usage error)
 *
 * Usage:
 *   bun scripts/capture-web-screenshots.ts \
 *     [--outdir=./screenshots] \
 *     [--viewport=1440x900] \
 *     [--route=/path] \
 *     [--timeout-ms=15000]
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import {
  type SeedResult,
  seedScreenshotFixtures,
} from "../apps/web/test/helpers/screenshot-seed.ts";

// --- Types --------------------------------------------------------------------

export interface CaptureArgs {
  readonly outdir: string;
  readonly viewport: { readonly width: number; readonly height: number };
  /** Explicit route overrides. When unset, a baked-in list is used. */
  readonly routes: readonly string[] | null;
  readonly timeoutMs: number;
}

export type ProgressEvent =
  | {
      readonly kind: "shot";
      readonly route: string;
      readonly path: string;
      readonly width: number;
      readonly height: number;
      readonly bytes: number;
    }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "server-ready"; readonly url: string }
  | { readonly kind: "error"; readonly stage: string; readonly message: string };

export type BrowserShot = (input: {
  readonly url: string;
  readonly outPath: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly timeoutMs: number;
}) => Promise<{ readonly bytes: number }>;

export interface CaptureDeps {
  readonly startServer: (stateDir: string) => Promise<{
    readonly url: string;
    readonly stop: () => Promise<void>;
  }>;
  readonly seed: (dbPath: string) => SeedResult | Promise<SeedResult>;
  readonly shot: BrowserShot;
  readonly onEvent: (ev: ProgressEvent) => void;
  readonly mkTempDir: () => Promise<string>;
  readonly removeTempDir: (dir: string) => Promise<void>;
}

// --- Pure helpers -------------------------------------------------------------

/**
 * Parse CLI arguments. Exported for tests.
 */
export function parseArgs(argv: readonly string[]): CaptureArgs {
  let outdir = "./screenshots";
  let viewport = { width: 1440, height: 900 };
  let timeoutMs = 15_000;
  const routes: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith("--outdir=")) {
      outdir = arg.slice("--outdir=".length);
      continue;
    }
    if (arg.startsWith("--viewport=")) {
      viewport = parseViewport(arg.slice("--viewport=".length));
      continue;
    }
    if (arg.startsWith("--route=")) {
      routes.push(arg.slice("--route=".length));
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      const raw = arg.slice("--timeout-ms=".length);
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new TypeError(`--timeout-ms must be a positive integer, got ${raw}`);
      }
      timeoutMs = n;
      continue;
    }
    throw new TypeError(`unknown argument: ${arg}`);
  }

  return {
    outdir: resolve(outdir),
    viewport,
    routes: routes.length > 0 ? routes : null,
    timeoutMs,
  };
}

function parseViewport(raw: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(raw);
  if (!match?.[1] || !match[2]) {
    throw new TypeError(`--viewport must be WIDTHxHEIGHT (e.g. 1440x900), got ${raw}`);
  }
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (width <= 0 || height <= 0 || width > 10_000 || height > 10_000) {
    throw new RangeError(`--viewport dimensions out of range: ${raw}`);
  }
  return { width, height };
}

/**
 * Convert a route path (e.g. `/run/RUN001`) into a safe PNG filename stem.
 * Exported for tests.
 */
export function routeToSlug(route: string): string {
  const trimmed = route.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "home";
  const cleaned = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "route" : cleaned;
}

/**
 * Compose the final route list. Always starts with `/`, then `/new-run`
 * (the Phase 9.C control surface), then each seeded run's detail route,
 * in declaration order. Caller overrides win wholesale.
 */
export function resolveRoutes(
  seeded: SeedResult,
  override: readonly string[] | null,
): readonly string[] {
  if (override !== null && override.length > 0) return override;
  const base: string[] = ["/", "/new-run"];
  for (const run of seeded.runs) {
    base.push(`/run/${encodeURIComponent(run.runId)}`);
  }
  return base;
}

// --- Default browser shim (Playwright via npx) --------------------------------

const PLAYWRIGHT_PIN = "1.50.1";

/**
 * A minimal ESM driver that's written to a temp file and fed to
 * `npx -p playwright@<pin> node <path>`. Keeping this as a string literal
 * avoids dragging Playwright's types into `tsc --noEmit` at this script's
 * typecheck time.
 */
const DRIVER_SOURCE = `#!/usr/bin/env node
// Generated by scripts/capture-web-screenshots.ts — do not edit.
//
// \`npx -p playwright@<pin> node <script>\` installs the package into an
// npm-managed cache but does NOT set NODE_PATH, so a plain
// \`import "playwright"\` from this script fails with ERR_MODULE_NOT_FOUND
// — the ESM resolver looks in the script's own directory tree, not PATH.
//
// Workaround: derive the npx cache's \`node_modules/\` from the first
// \`_npx/.../node_modules/.bin\` entry on PATH and resolve via
// \`createRequire\`. This is a shape that npm has preserved across releases
// back to npx 7; if it ever breaks the fix is local to this string.
import { createRequire } from "node:module";

const pathSeparator = process.platform === "win32" ? ";" : ":";
const pathEntries = (process.env.PATH ?? "").split(pathSeparator);
const npxBin = pathEntries.find((p) => p.includes("_npx") && p.endsWith(".bin"));
if (!npxBin) {
  console.error("capture-web-screenshots driver: could not locate npx cache on PATH");
  process.exit(1);
}
const npxNodeModules = npxBin.slice(0, -".bin".length);
const req = createRequire(npxNodeModules + "/_anchor.js");
const { chromium } = req("playwright");

const [url, outPath, viewportW, viewportH, timeoutMs] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true });
const pageErrors = [];
try {
  const context = await browser.newContext({
    viewport: { width: Number(viewportW), height: Number(viewportH) },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push("console.error: " + msg.text());
  });
  await page.goto(url, { waitUntil: "load", timeout: Number(timeoutMs) });
  // Wait until the SolidJS bundle has hydrated into \`#app\`. We don't use
  // \`networkidle\` because the SSE stream is persistent — the idle state
  // would wait for the heartbeat gap and bloat every shot.
  await page
    .waitForFunction(
      () => document.querySelector("#app")?.children.length && document.querySelector("#app").children.length > 0,
      null,
      { timeout: Number(timeoutMs), polling: 100 },
    )
    .catch(() => {
      /* fall through to the screenshot even if hydration didn't finish */
    });
  // One more beat so route-level data fetches (\`/api/runs\`,
  // \`/api/runs/:id\`) have time to resolve before we snap.
  await page.waitForTimeout(750);
  await page.screenshot({ path: outPath, fullPage: false });
  if (pageErrors.length) {
    process.stderr.write("capture: page had errors — " + pageErrors.slice(0, 3).join(" | ") + "\\n");
  }
} finally {
  await browser.close();
}
`;

let cachedDriverPath: string | null = null;

async function ensureDriverScript(): Promise<string> {
  if (cachedDriverPath !== null) return cachedDriverPath;
  const dir = await mkdtemp(join(tmpdir(), "shamu-shot-driver-"));
  const path = join(dir, "driver.mjs");
  await writeFile(path, DRIVER_SOURCE, "utf8");
  cachedDriverPath = path;
  return path;
}

export async function defaultShot(input: {
  readonly url: string;
  readonly outPath: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly timeoutMs: number;
}): Promise<{ readonly bytes: number }> {
  const driver = await ensureDriverScript();
  await mkdir(dirname(input.outPath), { recursive: true });
  const { stderr, code } = await spawnCollecting("npx", [
    "-y",
    "-p",
    `playwright@${PLAYWRIGHT_PIN}`,
    "node",
    driver,
    input.url,
    input.outPath,
    String(input.viewport.width),
    String(input.viewport.height),
    String(input.timeoutMs),
  ]);
  if (code !== 0) {
    throw new Error(`playwright driver exited ${code}: ${stderr.slice(0, 500)}`);
  }
  const file = Bun.file(input.outPath);
  const size = file.size;
  return { bytes: size };
}

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function spawnCollecting(command: string, args: readonly string[]): Promise<SpawnResult> {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", rejectFn);
    child.on("close", (code) => {
      resolveFn({ stdout, stderr, code: code ?? -1 });
    });
  });
}

// --- Orchestration ------------------------------------------------------------

/**
 * Full capture run. Composable via `deps` for tests.
 */
export async function runCapture(args: CaptureArgs, deps: CaptureDeps): Promise<number> {
  await mkdir(args.outdir, { recursive: true });
  const stateDir = await deps.mkTempDir();
  try {
    let serverHandle: { url: string; stop: () => Promise<void> };
    try {
      serverHandle = await deps.startServer(stateDir);
    } catch (cause) {
      deps.onEvent({
        kind: "error",
        stage: "server",
        message: cause instanceof Error ? cause.message : String(cause),
      });
      return 10;
    }
    try {
      let seeded: SeedResult;
      try {
        // The persistence helper opens a second connection against the same
        // file as the server (SQLite WAL makes that safe for the write-once
        // seed pattern). `openDatabase` runs migrations idempotently.
        seeded = await deps.seed(join(stateDir, "shamu.db"));
      } catch (cause) {
        deps.onEvent({
          kind: "error",
          stage: "seed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
        return 10;
      }
      deps.onEvent({ kind: "server-ready", url: serverHandle.url });

      const routes = resolveRoutes(seeded, args.routes);
      let sawFailure = false;
      for (const route of routes) {
        const slug = routeToSlug(route);
        const outPath = join(args.outdir, `${slug}.png`);
        try {
          const result = await deps.shot({
            url: `${serverHandle.url}${route}`,
            outPath,
            viewport: args.viewport,
            timeoutMs: args.timeoutMs,
          });
          deps.onEvent({
            kind: "shot",
            route,
            path: outPath,
            width: args.viewport.width,
            height: args.viewport.height,
            bytes: result.bytes,
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          if (isMissingBrowserError(message)) {
            deps.onEvent({
              kind: "skip",
              reason: `playwright chromium missing (${message.slice(0, 160)})`,
            });
            return 2;
          }
          sawFailure = true;
          deps.onEvent({ kind: "error", stage: `shot ${route}`, message });
        }
      }
      return sawFailure ? 20 : 0;
    } finally {
      await serverHandle.stop().catch(() => {
        // best-effort — the server may have already closed if the seed
        // step aborted mid-way.
      });
    }
  } finally {
    await deps.removeTempDir(stateDir).catch(() => {
      // best-effort — leftover temp dirs get GC'd by the OS.
    });
  }
}

/**
 * Heuristic: is this error text a "Playwright's Chromium isn't installed"
 * signal? Exported so tests can cover the soft-fail path.
 */
export function isMissingBrowserError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("executable doesn't exist") ||
    lower.includes("executable doesn\u2019t exist") ||
    lower.includes("browser type has not been installed") ||
    lower.includes("please run the following command") ||
    lower.includes("playwright install") ||
    lower.includes("cannot find module 'playwright'") ||
    lower.includes("chromium is not found") ||
    lower.includes("no such file or directory, open '/root/.cache/ms-playwright") ||
    lower.includes("error: failed to download") ||
    lower.includes("command not found: npx")
  );
}

// --- Default wiring (used when the script runs as an entrypoint) --------------

async function defaultMkTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "shamu-screenshots-"));
}

async function defaultRemoveTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function defaultStartServer(
  stateDir: string,
): Promise<{ url: string; stop: () => Promise<void> }> {
  // Relative import so root `tsc --noEmit` resolves it without workspace
  // path aliasing. Dynamic so test entrypoints (which stub `startServer`)
  // don't pull `Bun.serve` into the test process graph unless asked.
  //
  // IMPORTANT: we deliberately don't pass `port: 0` (OS-assigned) — the
  // server's origin allow-list is computed from the requested port at
  // config-resolution time, so binding to 0 leaves the allow-list pointing
  // at `:0` while the OS picks a real port. The browser then gets 403s on
  // every `fetch()` call and the page stays blank. Pre-allocating a free
  // port via `findFreePort()` keeps `allowedOrigins` in sync with the
  // listener.
  const port = await findFreePort();
  const mod = await import("../apps/web/src/server/index.ts");
  return mod.startServer({ stateDir, port });
}

/**
 * Probe for a free ephemeral port by briefly binding `Bun.serve` to `:0`
 * and reading back the assigned port. Cheap and race-prone (the OS could
 * reassign the port before we re-bind), but good enough for the one-shot
 * screenshot workflow.
 */
async function findFreePort(): Promise<number> {
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response("probe"),
  });
  const port = probe.port;
  probe.stop(true);
  if (typeof port !== "number") {
    throw new Error("findFreePort: Bun.serve did not report a numeric port");
  }
  return port;
}

async function defaultSeed(dbPath: string): Promise<SeedResult> {
  // Relative import so root `tsc --noEmit` resolves it without workspace
  // path aliasing, mirroring `generate-capability-matrix.ts`'s pattern.
  // `bun:sqlite` only loads inside `openDatabase()`, so the eager module
  // load here is cheap.
  const mod = await import("../packages/persistence/src/index.ts");
  const db = mod.openDatabase(dbPath);
  try {
    return seedScreenshotFixtures(db);
  } finally {
    db.close();
  }
}

function defaultOnEvent(ev: ProgressEvent): void {
  process.stdout.write(`${JSON.stringify(ev)}\n`);
}

async function main(): Promise<void> {
  let args: CaptureArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`capture-web-screenshots: ${message}\n`);
    process.stderr.write(
      "usage: bun scripts/capture-web-screenshots.ts [--outdir=./screenshots] [--viewport=WxH] [--route=/path]* [--timeout-ms=N]\n",
    );
    process.exit(64);
  }

  const code = await runCapture(args, {
    startServer: defaultStartServer,
    seed: defaultSeed,
    shot: defaultShot,
    onEvent: defaultOnEvent,
    mkTempDir: defaultMkTempDir,
    removeTempDir: defaultRemoveTempDir,
  });
  process.exit(code);
}

// Only self-start when run as a script.
const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  void main();
}
