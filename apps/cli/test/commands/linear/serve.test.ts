/**
 * Tests for `shamu linear serve`. Drives the CLI as a subprocess; uses
 * the `SHAMU_LINEAR_API_URL` test seam to point the Linear client at a
 * local mock server so the happy-boot path exits cleanly on SIGTERM.
 *
 * Scope:
 *   1. USAGE: `--team-id` / $LINEAR_TEAM_ID missing.
 *   2. USAGE: `--webhook-secret` / $LINEAR_WEBHOOK_SECRET missing.
 *   3. Happy boot: sends SIGTERM; daemon drains and exits OK.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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

function runCliSync(
  args: string[],
  env: Record<string, string> = {},
): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  const res = spawnSync("bun", [CLI_ENTRY, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: childEnv(env),
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status,
  };
}

function startLabelsServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        // Respond with a team that has all four shamu:* labels. Any
        // operation the runtime calls during boot / shutdown lands here.
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
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${matcher}`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      if (matcher.test(text)) {
        cleanup();
        resolve();
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

describe("shamu linear serve", () => {
  let tempDir: string;
  let labelsServer: Server | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "shamu-serve-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    if (labelsServer) {
      labelsServer.close();
      labelsServer = null;
    }
  });

  it("fails with USAGE when --team-id and $LINEAR_TEAM_ID are both missing", () => {
    const r = runCliSync(["linear", "serve", "--webhook-secret", "s"], {
      LINEAR_API_KEY: "dummy",
      LINEAR_TEAM_ID: "",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("team-id");
  });

  it("fails with USAGE when --webhook-secret and $LINEAR_WEBHOOK_SECRET are both missing", () => {
    const r = runCliSync(["linear", "serve", "--team-id", "t"], {
      LINEAR_API_KEY: "dummy",
      LINEAR_WEBHOOK_SECRET: "",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("webhook-secret");
  });

  it("boots + drains cleanly on SIGTERM", async () => {
    const { server, url } = await startLabelsServer();
    labelsServer = server;

    // Use port 0 so Bun picks an ephemeral port — avoids clashing with
    // anything the local dev already has bound. The runtime reports the
    // actual port on `linear serve: webhook server listening`.
    const proc = spawn(
      "bun",
      [
        CLI_ENTRY,
        "linear",
        "serve",
        "--team-id",
        "team-1",
        "--webhook-secret",
        "test-secret",
        "--webhook-port",
        "0",
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

    proc.kill("SIGTERM");
    const exitCode: number = await new Promise((resolve) => {
      proc.once("exit", (code) => resolve(code ?? -1));
    });
    // `runtime.stop()` drains, then the daemon exits 0. A failed exit
    // would indicate the shutdown path wedged; that's a regression worth
    // failing on.
    expect(exitCode).toBe(0);
  }, 30_000);
});
