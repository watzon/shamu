/**
 * Unit tests for the capture-web-screenshots pipeline.
 *
 * The browser launcher and server boot are injected via `CaptureDeps`, so
 * these tests never touch Playwright or spin up the real Hono app. A
 * separate, env-gated integration smoke (`SHAMU_SCREENSHOTS_SMOKE=1`) in the
 * workflow's "local smoke" step exercises the real stack.
 *
 * Runner note: these tests use Bun's native `bun:test` because the root
 * vitest config doesn't include `scripts/**` and we don't want to introduce
 * a workspace package just to host two files. They're invoked via
 * `bun test scripts/capture-web-screenshots.test.ts` from the workflow and
 * the local smoke.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SeedResult } from "../apps/web/test/helpers/screenshot-seed.ts";
import {
  type BrowserShot,
  type CaptureDeps,
  isMissingBrowserError,
  type ProgressEvent,
  parseArgs,
  resolveRoutes,
  routeToSlug,
  runCapture,
} from "./capture-web-screenshots.ts";

// Scratch directory the tests allocate and tear down per-case.
let tmpOutDir = "";
let tmpStateDir = "";

beforeEach(() => {
  tmpOutDir = mkdtempSync(join(tmpdir(), "shamu-shot-test-out-"));
  tmpStateDir = mkdtempSync(join(tmpdir(), "shamu-shot-test-state-"));
});

afterEach(() => {
  if (tmpOutDir && existsSync(tmpOutDir)) rmSync(tmpOutDir, { recursive: true, force: true });
  if (tmpStateDir && existsSync(tmpStateDir)) rmSync(tmpStateDir, { recursive: true, force: true });
});

function fakeSeed(): SeedResult {
  return {
    swarmId: "SW0000000000000000000000001",
    runs: [
      {
        runId: "RUN0000000000000000000000001",
        swarmId: "SW0000000000000000000000001",
        eventCount: 7,
      },
      {
        runId: "RUN0000000000000000000000002",
        swarmId: "SW0000000000000000000000001",
        eventCount: 7,
      },
    ],
  };
}

function makeDeps(overrides: Partial<CaptureDeps> = {}): {
  deps: CaptureDeps;
  events: ProgressEvent[];
  shotCalls: Array<Parameters<BrowserShot>[0]>;
  teardownCalled: { value: boolean };
  removedDirs: string[];
} {
  const events: ProgressEvent[] = [];
  const shotCalls: Array<Parameters<BrowserShot>[0]> = [];
  const teardownCalled = { value: false };
  const removedDirs: string[] = [];
  const deps: CaptureDeps = {
    startServer: async () => ({
      url: "http://127.0.0.1:45999",
      stop: async () => {
        teardownCalled.value = true;
      },
    }),
    seed: () => fakeSeed(),
    shot: async (input) => {
      shotCalls.push(input);
      // Simulate a 12-byte PNG write so `bytes` in progress events is stable.
      await Bun.write(input.outPath, new Uint8Array(12));
      return { bytes: 12 };
    },
    onEvent: (ev) => events.push(ev),
    mkTempDir: async () => tmpStateDir,
    removeTempDir: async (dir) => {
      removedDirs.push(dir);
    },
    ...overrides,
  };
  return { deps, events, shotCalls, teardownCalled, removedDirs };
}

describe("parseArgs", () => {
  it("applies defaults when no flags are provided", () => {
    const args = parseArgs([]);
    expect(args.outdir.endsWith("screenshots")).toBe(true);
    expect(args.viewport).toEqual({ width: 1440, height: 900 });
    expect(args.routes).toBeNull();
    expect(args.timeoutMs).toBe(15_000);
  });

  it("parses --outdir, --viewport, --route (repeatable), --timeout-ms", () => {
    const args = parseArgs([
      "--outdir=/tmp/shots",
      "--viewport=1280x720",
      "--route=/",
      "--route=/run/RUN0000000000000000000000001",
      "--timeout-ms=30000",
    ]);
    expect(args.outdir).toBe("/tmp/shots");
    expect(args.viewport).toEqual({ width: 1280, height: 720 });
    expect(args.routes).toEqual(["/", "/run/RUN0000000000000000000000001"]);
    expect(args.timeoutMs).toBe(30_000);
  });

  it("rejects malformed viewports", () => {
    expect(() => parseArgs(["--viewport=1440"])).toThrow();
    expect(() => parseArgs(["--viewport=0x0"])).toThrow();
    expect(() => parseArgs(["--viewport=99999x99999"])).toThrow();
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });

  it("rejects non-positive timeouts", () => {
    expect(() => parseArgs(["--timeout-ms=0"])).toThrow();
    expect(() => parseArgs(["--timeout-ms=-1"])).toThrow();
    expect(() => parseArgs(["--timeout-ms=notanumber"])).toThrow();
  });
});

describe("routeToSlug", () => {
  it("maps `/` to `home`", () => {
    expect(routeToSlug("/")).toBe("home");
  });

  it("maps `/run/:id` to a filesystem-safe stem", () => {
    expect(routeToSlug("/run/RUN0000000000000000000000001")).toBe(
      "run-RUN0000000000000000000000001",
    );
  });

  it("collapses illegal characters and trims edges", () => {
    expect(routeToSlug("//foo bar//baz?qs=1")).toBe("foo-bar-baz-qs-1");
  });

  it("falls back to `route` for paths with only illegal chars", () => {
    expect(routeToSlug("/??/")).toBe("route");
  });
});

describe("resolveRoutes", () => {
  it("uses caller override when provided", () => {
    const routes = resolveRoutes(fakeSeed(), ["/custom"]);
    expect(routes).toEqual(["/custom"]);
  });

  it("builds `/` + run detail URLs from the seed result", () => {
    const routes = resolveRoutes(fakeSeed(), null);
    expect(routes).toEqual([
      "/",
      "/run/RUN0000000000000000000000001",
      "/run/RUN0000000000000000000000002",
    ]);
  });

  it("treats an empty override as absent", () => {
    const routes = resolveRoutes(fakeSeed(), []);
    expect(routes[0]).toBe("/");
  });
});

describe("isMissingBrowserError", () => {
  it("matches the canonical Playwright error strings", () => {
    expect(
      isMissingBrowserError("Executable doesn't exist at /root/.cache/ms-playwright/chromium-1129"),
    ).toBe(true);
    expect(
      isMissingBrowserError(
        "browserType.launch: Browser type has not been installed. Please run the following command: npx playwright install",
      ),
    ).toBe(true);
    expect(isMissingBrowserError("Cannot find module 'playwright'")).toBe(true);
  });

  it("does not match generic errors", () => {
    expect(isMissingBrowserError("Timed out waiting for networkidle")).toBe(false);
    expect(isMissingBrowserError("Page crashed")).toBe(false);
  });
});

describe("runCapture", () => {
  it("writes a PNG per route, emits NDJSON events, and tears everything down", async () => {
    const { deps, events, shotCalls, teardownCalled, removedDirs } = makeDeps();
    const code = await runCapture(
      {
        outdir: tmpOutDir,
        viewport: { width: 1440, height: 900 },
        routes: null,
        timeoutMs: 5_000,
      },
      deps,
    );
    expect(code).toBe(0);
    expect(shotCalls).toHaveLength(3); // `/` + 2 seeded runs
    expect(shotCalls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:45999/",
      "http://127.0.0.1:45999/run/RUN0000000000000000000000001",
      "http://127.0.0.1:45999/run/RUN0000000000000000000000002",
    ]);
    // Outdir actually contains the three files we claimed to write.
    const files = readdirSync(tmpOutDir).sort();
    expect(files).toEqual([
      "home.png",
      "run-RUN0000000000000000000000001.png",
      "run-RUN0000000000000000000000002.png",
    ]);
    // NDJSON events in the expected order/shape.
    expect(events[0]).toEqual({ kind: "server-ready", url: "http://127.0.0.1:45999" });
    const shots = events.filter((e) => e.kind === "shot");
    expect(shots).toHaveLength(3);
    for (const ev of shots) {
      expect(ev).toMatchObject({
        kind: "shot",
        width: 1440,
        height: 900,
        bytes: 12,
      });
    }
    // Server + state-dir cleanup both run.
    expect(teardownCalled.value).toBe(true);
    expect(removedDirs).toEqual([tmpStateDir]);
  });

  it("returns exit code 10 when the server fails to boot", async () => {
    const { deps, events, shotCalls, removedDirs } = makeDeps({
      startServer: async () => {
        throw new Error("EADDRINUSE: port already in use");
      },
    });
    const code = await runCapture(
      {
        outdir: tmpOutDir,
        viewport: { width: 1440, height: 900 },
        routes: null,
        timeoutMs: 5_000,
      },
      deps,
    );
    expect(code).toBe(10);
    expect(shotCalls).toHaveLength(0);
    expect(events[0]).toMatchObject({ kind: "error", stage: "server" });
    // Temp state dir still gets cleaned up even on server failure.
    expect(removedDirs).toEqual([tmpStateDir]);
  });

  it("returns exit code 10 when seeding fails", async () => {
    const { deps, events, teardownCalled } = makeDeps({
      seed: () => {
        throw new Error("schema mismatch: cannot seed");
      },
    });
    const code = await runCapture(
      {
        outdir: tmpOutDir,
        viewport: { width: 1440, height: 900 },
        routes: null,
        timeoutMs: 5_000,
      },
      deps,
    );
    expect(code).toBe(10);
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      kind: "error",
      stage: "seed",
    });
    // Even when seeding fails, the already-booted server gets stopped.
    expect(teardownCalled.value).toBe(true);
  });

  it("returns exit code 2 when the first shot reports a missing browser", async () => {
    let calls = 0;
    const { deps, events } = makeDeps({
      shot: async () => {
        calls += 1;
        throw new Error(
          "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1129/chrome-linux/chrome",
        );
      },
    });
    const code = await runCapture(
      {
        outdir: tmpOutDir,
        viewport: { width: 1440, height: 900 },
        routes: null,
        timeoutMs: 5_000,
      },
      deps,
    );
    expect(code).toBe(2);
    // Short-circuits after the first missing-browser failure rather than
    // retrying every route (the rest will all fail the same way).
    expect(calls).toBe(1);
    expect(events.find((e) => e.kind === "skip")).toBeTruthy();
  });

  it("returns exit code 20 on a shot failure that isn't a missing-browser error", async () => {
    const { deps, events } = makeDeps({
      shot: async () => {
        throw new Error("navigation timeout after 5000ms");
      },
    });
    const code = await runCapture(
      {
        outdir: tmpOutDir,
        viewport: { width: 1440, height: 900 },
        routes: null,
        timeoutMs: 5_000,
      },
      deps,
    );
    expect(code).toBe(20);
    const errors = events.filter((e) => e.kind === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]).toMatchObject({ kind: "error" });
  });

  it("honors an explicit --route override", async () => {
    const { deps, shotCalls } = makeDeps();
    const code = await runCapture(
      {
        outdir: tmpOutDir,
        viewport: { width: 800, height: 600 },
        routes: ["/custom"],
        timeoutMs: 5_000,
      },
      deps,
    );
    expect(code).toBe(0);
    expect(shotCalls).toHaveLength(1);
    expect(shotCalls[0]?.url).toBe("http://127.0.0.1:45999/custom");
  });
});
