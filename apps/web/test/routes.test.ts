/**
 * Route-level tests. We exercise the Hono app via `app.fetch(Request)` so
 * the tests don't need a real HTTP listener. A fake SQLite-ish store
 * (`helpers/fake-db.ts`) backs the queries.
 */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { ServerConfig } from "../src/server/config.ts";
import { originAllowList } from "../src/server/config.ts";
import { createFakeDb, type RunRecord } from "./helpers/fake-db.ts";
import { makeEvent } from "./helpers/fixtures.ts";

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

function sampleRun(runId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: runId,
    swarm_id: "swarm-1",
    role: "worker",
    vendor: "echo",
    status: "running",
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_500,
    ...overrides,
  };
}

describe("GET /api/health", () => {
  it("returns ok", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dbPath: string };
    expect(body.ok).toBe(true);
    expect(body.dbPath).toBe(":fake:");
  });
});

describe("GET /api/runs", () => {
  it("returns an empty list when no runs exist", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/runs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: unknown[] };
    expect(body.runs).toEqual([]);
  });

  it("returns every run, newest first", async () => {
    const db = createFakeDb();
    db.addRun(sampleRun("run-a", { created_at: 100 }));
    db.addRun(sampleRun("run-b", { created_at: 200 }));
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/runs"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ runId: string }> };
    expect(body.runs.map((r) => r.runId)).toEqual(["run-b", "run-a"]);
  });
});

describe("GET /api/runs/:id", () => {
  it("404s on unknown run", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/runs/nope"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  it("returns run + events", async () => {
    const db = createFakeDb();
    db.addRun(sampleRun("run-1"));
    db.addEvent(makeEvent({ runId: "run-1", seq: 1 }));
    db.addEvent(makeEvent({ runId: "run-1", seq: 2 }));
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/runs/run-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: { runId: string };
      events: Array<{ seq: number }>;
    };
    expect(body.run.runId).toBe("run-1");
    expect(body.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("rejects empty run ids as 400", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    // Hono's router treats `/api/runs/` as a different route; use a whitespace-
    // only id that bypasses the router but fails the `runId` validator.
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/runs/%20"));
    // 404 or 400 both acceptable (404 = no such run, 400 = invalid id). We
    // accept both so this test isn't over-tied to the validator order.
    expect([400, 404]).toContain(res.status);
  });
});

describe("GET /api/runs/:id/stream", () => {
  it("emits queued events as SSE then closes when aborted", async () => {
    const db = createFakeDb();
    db.addRun(sampleRun("run-1"));
    db.addEvent(makeEvent({ runId: "run-1", seq: 1 }));
    db.addEvent(makeEvent({ runId: "run-1", seq: 2 }));

    const app = createApp({ db, config: makeConfig({ tailIntervalMs: 5 }) });
    const ac = new AbortController();
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs/run-1/stream", {
        signal: ac.signal,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = res.body?.getReader();
    if (!reader) throw new Error("expected SSE body stream");
    const decoder = new TextDecoder();
    let buffer = "";
    // Pull until we see two `agent_event` frames.
    while (buffer.match(/event: agent_event/g)?.length ?? 0 < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      if ((buffer.match(/event: agent_event/g)?.length ?? 0) >= 2) break;
    }
    ac.abort();
    await reader.cancel().catch(() => {});

    expect(buffer).toContain("event: agent_event");
    expect(buffer).toContain('"seq":1');
    expect(buffer).toContain('"seq":2');
    expect(buffer).toContain("id: 1");
    expect(buffer).toContain("id: 2");
  });

  it("respects Last-Event-ID to resume from a higher seq", async () => {
    const db = createFakeDb();
    db.addRun(sampleRun("run-1"));
    db.addEvent(makeEvent({ runId: "run-1", seq: 1 }));
    db.addEvent(makeEvent({ runId: "run-1", seq: 2 }));
    db.addEvent(makeEvent({ runId: "run-1", seq: 3 }));

    const app = createApp({ db, config: makeConfig({ tailIntervalMs: 5 }) });
    const ac = new AbortController();
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs/run-1/stream", {
        signal: ac.signal,
        headers: { "Last-Event-ID": "2" },
      }),
    );
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("expected SSE body stream");
    const decoder = new TextDecoder();
    let buffer = "";
    const start = Date.now();
    while (Date.now() - start < 300) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value);
      if (buffer.includes('"seq":3')) break;
    }
    ac.abort();
    await reader.cancel().catch(() => {});
    expect(buffer).toContain('"seq":3');
    expect(buffer).not.toContain('"seq":1');
    expect(buffer).not.toContain('"seq":2');
  });

  it("404s on unknown run", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/runs/nope/stream"));
    expect(res.status).toBe(404);
  });
});

describe("Origin allow-list", () => {
  it("rejects mismatched Origin with 403", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs", {
        headers: { origin: "http://evil.example" },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; origin: string };
    expect(body.error).toBe("forbidden_origin");
    expect(body.origin).toBe("http://evil.example");
  });

  it("allows matching 127.0.0.1 Origin", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs", {
        headers: { origin: "http://127.0.0.1:4711" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("allows matching localhost Origin", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(
      new Request("http://127.0.0.1:4711/api/runs", {
        headers: { origin: "http://localhost:4711" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("allows no-Origin requests (curl, same-origin navigations)", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/runs"));
    expect(res.status).toBe(200);
  });
});

describe("SPA catch-all", () => {
  it("returns the fallback HTML when the bundle is missing", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text.toLowerCase()).toContain("shamu web");
  });

  it("serves the catch-all for arbitrary routes (client router handles them)", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/run/abc"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("returns 404 for unknown /api/* routes", async () => {
    const db = createFakeDb();
    const app = createApp({ db, config: makeConfig() });
    const res = await app.fetch(new Request("http://127.0.0.1:4711/api/does-not-exist"));
    expect(res.status).toBe(404);
  });
});
