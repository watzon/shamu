/**
 * Tests for the Phase 9.C control-surface endpoints.
 *
 * Scope: `POST /api/runs`, `POST /api/runs/:id/interrupt`, `GET /api/csrf`,
 * `GET /api/adapters/available`, `GET /api/adapters/:vendor/models`.
 *
 * The `@shamu/web` test suite runs under Vitest; `bun:sqlite` isn't
 * available in Vitest workers (see HANDOFF recurring-constraints), so
 * these tests inject stubs for `startRun` / `interruptRun` rather than
 * hitting the real adapter spawn path. Contract coverage for the
 * runner itself lives in sibling tests that talk to the echo adapter
 * directly once a bun-test harness lands (followup).
 */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { ServerConfig } from "../src/server/config.ts";
import { originAllowList } from "../src/server/config.ts";
import { CSRF_COOKIE_NAME } from "../src/server/csrf.ts";
import type { StartRunInput, StartRunResult } from "../src/server/runs-runner.ts";
import { createFakeDb } from "./helpers/fake-db.ts";

function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const port = overrides.port ?? 4711;
  return {
    port,
    host: "127.0.0.1",
    dbPath: ":fake:",
    staticDir: "/tmp/nonexistent-shamu-web",
    allowedOrigins: overrides.allowedOrigins ?? originAllowList(port),
    tailIntervalMs: overrides.tailIntervalMs ?? 10,
    tailBatchSize: overrides.tailBatchSize ?? 50,
  };
}

/**
 * Mint a CSRF cookie+token pair the way a real SPA would. We call
 * `GET /api/csrf` and parse the Set-Cookie + body out of the response.
 */
async function mintCsrf(
  app: ReturnType<typeof createApp>,
): Promise<{ cookie: string; token: string }> {
  const res = await app.fetch(new Request("http://127.0.0.1:4711/api/csrf"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string; cookie: string };
  const setCookie = res.headers.get("set-cookie");
  if (setCookie === null) throw new Error("expected Set-Cookie header from /api/csrf");
  // Extract just the `shamu_csrf=<value>` segment — the rest of the
  // attributes (Path=/, SameSite=Strict) aren't relevant for the
  // double-submit.
  const match = new RegExp(`${CSRF_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  if (!match?.[1]) throw new Error(`malformed Set-Cookie: ${setCookie}`);
  return { cookie: `${CSRF_COOKIE_NAME}=${match[1]}`, token: body.token };
}

describe("GET /api/csrf", () => {
  it("mints a token and sets the shamu_csrf cookie", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/csrf"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token.length).toBeGreaterThan(20);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toMatch(new RegExp(`^${CSRF_COOKIE_NAME}=.+`));
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("SameSite=Strict");
  });
});

describe("POST /api/runs", () => {
  it("rejects requests missing the CSRF header", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const { cookie } = await mintCsrf(app);
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          // no X-CSRF-Token header
        },
        body: JSON.stringify({ task: "hello", adapter: "echo", role: "executor" }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("csrf_missing");
    expect(body.reason).toBe("missing-header");
  });

  it("rejects requests missing the CSRF cookie", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const { token } = await mintCsrf(app);
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // no cookie
          "x-csrf-token": token,
        },
        body: JSON.stringify({ task: "hello", adapter: "echo", role: "executor" }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("missing-cookie");
  });

  it("rejects mismatched CSRF token vs cookie", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const { cookie } = await mintCsrf(app);
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-csrf-token": "wrong-value",
        },
        body: JSON.stringify({ task: "hello", adapter: "echo", role: "executor" }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("mismatch");
  });

  it("returns { ok: true, runId, url } on happy path", async () => {
    const db = createFakeDb();
    const startCalls: StartRunInput[] = [];
    const app = createApp({
      db,
      config: makeConfig(),
      startRun: async (input): Promise<StartRunResult> => {
        startCalls.push(input);
        return { ok: true, runId: "run-test-1" as never, url: "/run/run-test-1" };
      },
    });
    const { cookie, token } = await mintCsrf(app);
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-csrf-token": token,
        },
        body: JSON.stringify({
          task: "hello world",
          adapter: "echo",
          role: "executor",
          model: "echo-default",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; runId: string; url: string };
    expect(body.ok).toBe(true);
    expect(body.runId).toBe("run-test-1");
    expect(body.url).toBe("/run/run-test-1");
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]?.task).toBe("hello world");
    expect(startCalls[0]?.adapter).toBe("echo");
    expect(startCalls[0]?.model).toBe("echo-default");
  });

  it("returns structured vendor-cli-not-found error when the resolver misses", async () => {
    const db = createFakeDb();
    const app = createApp({
      db,
      config: makeConfig(),
      startRun: async (): Promise<StartRunResult> => ({
        ok: false,
        code: "vendor-cli-not-found",
        adapter: "codex",
        checked: ["/usr/local/bin/codex", "/opt/homebrew/bin/codex"],
        message: "Vendor CLI for 'codex' not found.",
      }),
    });
    const { cookie, token } = await mintCsrf(app);
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-csrf-token": token,
        },
        body: JSON.stringify({ task: "hi", adapter: "codex", role: "executor" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      ok: boolean;
      code: string;
      adapter: string;
      checked: string[];
    };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("vendor-cli-not-found");
    expect(body.adapter).toBe("codex");
    expect(body.checked).toEqual(["/usr/local/bin/codex", "/opt/homebrew/bin/codex"]);
  });

  it("rejects unknown adapters with 400", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const { cookie, token } = await mintCsrf(app);
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-csrf-token": token,
        },
        body: JSON.stringify({ task: "hi", adapter: "nope", role: "executor" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_adapter");
  });

  it("rejects malformed JSON bodies with 400", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const { cookie, token } = await mintCsrf(app);
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-csrf-token": token,
        },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  it("rejects empty task with 400 from Zod validation", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const { cookie, token } = await mintCsrf(app);
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie,
          "x-csrf-token": token,
        },
        body: JSON.stringify({ task: "", adapter: "echo", role: "executor" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_body");
  });
});

describe("POST /api/runs/:id/interrupt", () => {
  it("rejects requests missing CSRF", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs/run-1/interrupt", {
        method: "POST",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns { ok: true, status: 'cancelled' } when the run is active", async () => {
    const db = createFakeDb();
    const interruptCalls: string[] = [];
    const app = createApp({
      db,
      config: makeConfig(),
      interruptRun: async (runId) => {
        interruptCalls.push(runId);
        return "cancelled";
      },
    });
    const { cookie, token } = await mintCsrf(app);
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs/run-42/interrupt", {
        method: "POST",
        headers: { cookie, "x-csrf-token": token },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("cancelled");
    expect(interruptCalls).toEqual(["run-42"]);
  });

  it("returns 404 when the run is not active", async () => {
    const db = createFakeDb();
    const app = createApp({
      db,
      config: makeConfig(),
      interruptRun: async () => "unknown",
    });
    const { cookie, token } = await mintCsrf(app);
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs/run-missing/interrupt", {
        method: "POST",
        headers: { cookie, "x-csrf-token": token },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("run_not_active");
  });
});

describe("GET /api/adapters/available", () => {
  it("returns a list with per-adapter resolution status", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/adapters/available"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      adapters: Array<{ vendor: string; ok: boolean; error?: string }>;
    };
    // Every non-echo adapter appears; echo is deliberately excluded.
    expect(body.adapters.map((a) => a.vendor)).not.toContain("echo");
    expect(body.adapters.length).toBeGreaterThan(0);
    // On a clean CI runner none of the vendor CLIs are installed, so we
    // just assert the structural shape — `ok: true` or `ok: false` are
    // both valid depending on the machine.
    for (const entry of body.adapters) {
      expect(typeof entry.vendor).toBe("string");
      expect(typeof entry.ok).toBe("boolean");
    }
  });
});

describe("GET /api/adapters/:vendor/models", () => {
  it("returns the echo adapter's model list", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/adapters/echo/models"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: Array<{ id: string; label: string; default?: boolean }>;
    };
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.models.some((m) => m.default === true)).toBe(true);
  });

  it("returns the claude model catalog with an id + label per entry", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/adapters/claude/models"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: Array<{ id: string; label: string }>;
    };
    for (const m of body.models) {
      expect(m.id.length).toBeGreaterThan(0);
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it("404s on an unknown adapter name", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/adapters/nope/models"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_adapter");
  });
});
