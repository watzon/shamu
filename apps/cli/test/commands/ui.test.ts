/**
 * Tests for `shamu ui`. Drives the CLI as a subprocess so we can send real
 * SIGTERMs and assert on the stdout/stderr banner + the graceful shutdown
 * path.
 *
 * Scope:
 *   1. `--help` exits 0 and lists `--port`, `--no-open`, `--unsafe-bind`.
 *   2. `--no-open --json --port <high>` prints a `ui-started` event with
 *      the expected URL, then cleanly exits on SIGTERM.
 *   3. `--state-dir <tempdir>` is honored so the test doesn't pollute
 *      `$cwd/.shamu/state`.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_ENTRY = join(__dirname, "..", "..", "src", "index.ts");

function childEnv(env: Record<string, string> = {}): Record<string, string> {
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
): { stdout: string; stderr: string; status: number | null } {
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

async function waitForStdoutMatch(
  proc: ChildProcess,
  matcher: RegExp,
  timeoutMs = 10_000,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${matcher} (got: ${JSON.stringify(buffer)})`));
    }, timeoutMs);
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString();
      if (matcher.test(buffer)) {
        cleanup();
        resolve(buffer);
      }
    };
    function cleanup(): void {
      clearTimeout(timer);
      proc.stdout?.off("data", onData);
    }
    proc.stdout?.on("data", onData);
  });
}

/** Pick a random high port to avoid collisions with dev servers. */
function randomHighPort(): number {
  return 20000 + Math.floor(Math.random() * 30000);
}

describe("shamu ui", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "shamu-ui-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("--help exits 0 and lists --port, --open, --no-open, --force-open, --unsafe-bind", () => {
    const r = runCliSync(["ui", "--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--port");
    // --open is the new opt-in flag. --no-open is a deprecated no-op kept
    // for back-compat. --force-open bypasses the TTY guard.
    expect(r.stdout).toContain("--open");
    expect(r.stdout).toContain("--no-open");
    expect(r.stdout).toContain("--force-open");
    expect(r.stdout).toContain("--unsafe-bind");
  });

  it("--no-open --json --port <high> prints ui-started then exits cleanly on SIGTERM", async () => {
    const port = randomHighPort();
    const proc = spawn(
      "bun",
      [CLI_ENTRY, "ui", "--no-open", "--json", "--port", String(port), "--state-dir", tempDir],
      {
        env: childEnv({ SHAMU_STATE_DIR: tempDir }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let buffer = "";
    try {
      buffer = await waitForStdoutMatch(proc, /ui-started/, 15_000);
    } catch (err) {
      proc.kill("SIGKILL");
      throw err;
    }

    // First line of stdout should be the JSON event.
    const firstLine = buffer.split("\n").find((l) => l.trim().length > 0);
    expect(firstLine).toBeDefined();
    const obj = JSON.parse(firstLine as string) as {
      kind: string;
      url: string;
      port: number;
      host: string;
    };
    expect(obj.kind).toBe("ui-started");
    expect(obj.port).toBe(port);
    expect(obj.host).toBe("127.0.0.1");
    expect(obj.url).toBe(`http://127.0.0.1:${port}`);

    proc.kill("SIGTERM");
    const result: { code: number | null; signal: NodeJS.Signals | null } = await new Promise(
      (resolve) => {
        proc.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    // Clean shutdown: exit code 0, not killed by signal.
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  }, 30_000);
});
