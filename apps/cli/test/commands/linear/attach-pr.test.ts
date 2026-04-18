/**
 * Tests for `shamu linear attach-pr`. Drives the CLI as a subprocess so
 * the full parse/validate/execute path is exercised. For happy + error
 * paths we stand up a local HTTP server and point the CLI at it via
 * `SHAMU_LINEAR_API_URL` (a test-seam env the command respects).
 */

import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_ENTRY = join(__dirname, "..", "..", "..", "src", "index.ts");

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function childEnv(env: Record<string, string>): Record<string, string> {
  const full = { ...process.env, ...env };
  delete full.NODE_OPTIONS;
  delete full.VITEST;
  delete full.VITEST_WORKER_ID;
  delete full.VITEST_POOL_ID;
  return full as Record<string, string>;
}

function runCliSync(args: string[], env: Record<string, string> = {}): CliResult {
  const res = spawnSync("bun", [CLI_ENTRY, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: childEnv(env),
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

/**
 * Async spawn + capture. Needed for any test where the CLI talks to a
 * local HTTP server running inside this process — `spawnSync` blocks the
 * event loop and the server never accepts the CLI's connection.
 */
async function runCliAsync(
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", [CLI_ENTRY, ...args], {
      env: childEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => {
      stdout += String(c);
    });
    proc.stderr.on("data", (c) => {
      stderr += String(c);
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`CLI timed out after ${timeoutMs}ms; stdout=${stdout}\nstderr=${stderr}`));
    }, timeoutMs);
    proc.once("exit", (status) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status });
    });
  });
}

interface MockServer {
  readonly server: Server;
  readonly url: string;
  readonly calls: Array<{ query: string; variables: Record<string, unknown> }>;
}

function startGraphqlServer(
  responder: (body: string) => { status: number; body: string },
): Promise<MockServer> {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as {
            query?: string;
            variables?: Record<string, unknown>;
          };
          calls.push({
            query: parsed.query ?? "",
            variables: parsed.variables ?? {},
          });
        } catch {
          // ignore — responder still gets the raw body.
        }
        const out = responder(body);
        res.statusCode = out.status;
        res.setHeader("content-type", "application/json");
        res.end(out.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}/`, calls });
    });
  });
}

describe("shamu linear attach-pr", () => {
  let mock: MockServer | null = null;

  beforeEach(() => {
    mock = null;
  });

  afterEach(() => {
    if (mock) mock.server.close();
    mock = null;
  });

  it("fails with USAGE when --issue is missing", () => {
    const r = runCliSync(["linear", "attach-pr", "--url", "https://x/y"], {
      LINEAR_API_KEY: "dummy-key",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/issue|usage|required/);
  });

  it("fails with USAGE when --url is missing", () => {
    const r = runCliSync(["linear", "attach-pr", "--issue", "iss-1"], {
      LINEAR_API_KEY: "dummy-key",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/url|usage|required/);
  });

  it("happy path: calls createAttachment and emits a JSON ok payload", async () => {
    mock = await startGraphqlServer(() => ({
      status: 200,
      body: JSON.stringify({
        data: {
          attachmentCreate: {
            success: true,
            attachment: { id: "att-1", url: "https://github.com/acme/repo/pull/42" },
          },
        },
      }),
    }));

    const r = await runCliAsync(
      [
        "linear",
        "attach-pr",
        "--issue",
        "iss-1",
        "--url",
        "https://github.com/acme/repo/pull/42",
        "--title",
        "acme/repo#42",
        "--json",
      ],
      {
        LINEAR_API_KEY: "dummy-key",
        SHAMU_LINEAR_API_URL: mock.url,
      },
    );

    expect(r.status).toBe(0);
    expect(mock.calls).toHaveLength(1);
    const firstCall = mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.variables).toMatchObject({
      issueId: "iss-1",
      url: "https://github.com/acme/repo/pull/42",
      title: "acme/repo#42",
    });
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    const payload = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const ok = payload.find((p) => p.kind === "linear-attach-pr-ok");
    expect(ok).toBeDefined();
    expect(ok?.issueId).toBe("iss-1");
    expect(ok?.attachmentId).toBe("att-1");
  });

  it("returns INTERNAL when the Linear side reports an error", async () => {
    mock = await startGraphqlServer(() => ({
      status: 200,
      body: JSON.stringify({
        errors: [{ message: "boom", extensions: { code: "INVALID_INPUT" } }],
      }),
    }));

    const r = await runCliAsync(
      ["linear", "attach-pr", "--issue", "iss-1", "--url", "https://example.com/pr/1"],
      {
        LINEAR_API_KEY: "dummy-key",
        SHAMU_LINEAR_API_URL: mock.url,
      },
    );

    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("attach-pr");
  });
});
