/**
 * Subprocess test — `shamu linear serve` drain-on-SIGTERM.
 *
 * Boots the daemon against a local Linear-labels mock; asserts that:
 *   - The `linear-serve-drain-started` JSON banner is emitted on the
 *     first SIGTERM.
 *   - The daemon exits 0 (clean drain) within the test's timeout.
 *
 * No in-flight run is generated here — the serve command exits cleanly
 * with zero in-flight runs, which is the simplest drain path to
 * regression-guard. The stateful drain (in-flight cancellation) is
 * covered by `linear-runtime-drain.test.ts`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_ENTRY = join(__dirname, "..", "..", "..", "src", "index.ts");

function childEnv(env: Record<string, string>): Record<string, string> {
  const full = { ...process.env, ...env };
  delete full.NODE_OPTIONS;
  delete full.VITEST;
  delete full.VITEST_WORKER_ID;
  delete full.VITEST_POOL_ID;
  return full as Record<string, string>;
}

function startLabelsServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            data: {
              team: {
                id: "team-1",
                labels: {
                  nodes: [
                    { id: "lbl-ready", name: "shamu:ready" },
                    { id: "lbl-in-progress", name: "shamu:in-progress" },
                    { id: "lbl-review", name: "shamu:review" },
                    { id: "lbl-blocked", name: "shamu:blocked" },
                  ],
                },
              },
            },
          }),
        );
        void body;
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

async function waitForStdoutMatch(
  proc: ChildProcess,
  matcher: RegExp,
  timeoutMs = 10_000,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let accumulated = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${matcher}; saw: ${accumulated.slice(-500)}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      accumulated += text;
      if (matcher.test(accumulated)) {
        cleanup();
        resolve(accumulated);
      }
    };
    function cleanup(): void {
      clearTimeout(timer);
      proc.stdout?.off("data", onData);
      proc.stderr?.off("data", onData);
    }
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
  });
}

describe("shamu linear serve (drain)", () => {
  let tempDir: string;
  let labelsServer: Server | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "shamu-serve-drain-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (labelsServer) {
      labelsServer.close();
      labelsServer = null;
    }
  });

  it("emits the drain banner on SIGTERM and exits 0", async () => {
    const { server, url } = await startLabelsServer();
    labelsServer = server;

    const proc = spawn(
      "bun",
      [
        CLI_ENTRY,
        "linear",
        "serve",
        "--team-id",
        "team-1",
        "--webhook-secret",
        "drain-secret",
        "--webhook-port",
        "0",
        "--drain-timeout",
        "1",
        "--json",
      ],
      {
        env: childEnv({
          LINEAR_API_KEY: "dummy-key",
          SHAMU_LINEAR_API_URL: url,
          SHAMU_STATE_DIR: tempDir,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      await waitForStdoutMatch(proc, /linear-serve-ready/, 15_000);
    } catch (err) {
      proc.kill("SIGKILL");
      throw err;
    }

    const drainBanner = waitForStdoutMatch(proc, /linear-serve-drain-started/, 10_000);
    proc.kill("SIGTERM");
    try {
      await drainBanner;
    } catch (err) {
      proc.kill("SIGKILL");
      throw err;
    }

    const exitCode: number = await new Promise((resolve) => {
      proc.once("exit", (code) => resolve(code ?? -1));
    });
    expect(exitCode).toBe(0);
  }, 30_000);
});
