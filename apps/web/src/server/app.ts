/**
 * Hono application factory.
 *
 * Wiring the app as a pure function (app-factory style) keeps it test-friendly
 * — each test can build a fresh app with an in-memory DB and an isolated set
 * of config overrides. The concrete `main()` in `index.ts` just calls this
 * with the env-derived config.
 *
 * Routes (all under `/api/*` except the SPA):
 *   - GET /api/health          → liveness probe
 *   - GET /api/runs            → list of RunRow
 *   - GET /api/runs/:id        → run detail + first page of events
 *   - GET /api/runs/:id/stream → SSE live-tail, honors Last-Event-ID
 *   - GET /                    → SolidJS SPA (static HTML)
 *   - GET /assets/*            → bundled JS/CSS
 *
 * Origin allow-list is enforced as the first middleware. Requests with a
 * missing `Origin` header (curl, fetch on same origin via browser) pass; a
 * mismatched `Origin` returns 403. This is the cross-origin CSRF boundary
 * for the SSE endpoint.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eventsQueries, runsQueries, type ShamuDatabase } from "@shamu/persistence";
import { runId as brandRunId } from "@shamu/shared/ids";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ServerConfig } from "./config.ts";

export interface AppDeps {
  readonly db: ShamuDatabase;
  readonly config: ServerConfig;
  /** Monotonic clock used to pace the SSE poll loop. Injectable for tests. */
  readonly now?: () => number;
  /** Yield between polls. Injectable so tests can run deterministically. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function originCheck(origin: string | undefined, allowed: readonly string[]): boolean {
  // No Origin header → same-origin navigation or curl. Allow.
  if (origin === undefined || origin === "") return true;
  return allowed.includes(origin);
}

export function createApp(deps: AppDeps): Hono {
  const { db, config } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const app = new Hono();

  // --- Origin allow-list ---------------------------------------------------
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (!originCheck(origin, config.allowedOrigins)) {
      return c.json({ error: "forbidden_origin", origin }, 403);
    }
    await next();
    return undefined;
  });

  // --- Health --------------------------------------------------------------
  app.get("/api/health", (c) => c.json({ ok: true, dbPath: config.dbPath }));

  // --- Runs list -----------------------------------------------------------
  app.get("/api/runs", (c) => {
    const rows = runsQueries.listRuns(db);
    return c.json({ runs: rows });
  });

  // --- Run detail + event page --------------------------------------------
  app.get("/api/runs/:id", (c) => {
    const id = c.req.param("id");
    const brandedOrError = tryBrandRunId(id);
    if (brandedOrError.ok === false) return c.json({ error: "invalid_run_id" }, 400);
    const branded = brandedOrError.value;
    const run = runsQueries.getRun(db, branded);
    if (run === null) return c.json({ error: "not_found" }, 404);
    const events = eventsQueries.getEventsByRun(db, branded);
    return c.json({ run, events });
  });

  // --- SSE live tail -------------------------------------------------------
  app.get("/api/runs/:id/stream", (c) => {
    const id = c.req.param("id");
    const brandedOrError = tryBrandRunId(id);
    if (brandedOrError.ok === false) return c.json({ error: "invalid_run_id" }, 400);
    const branded = brandedOrError.value;
    const run = runsQueries.getRun(db, branded);
    if (run === null) return c.json({ error: "not_found" }, 404);

    // The client may reconnect with Last-Event-ID, carrying the last `seq` it
    // saw. Fall back to 0 (full history since start) otherwise.
    const rawLastEventId = c.req.header("last-event-id");
    const initialSince = parseSeq(rawLastEventId, 0);

    return streamSSE(c, async (stream) => {
      let since = initialSince;
      let closed = false;
      stream.onAbort(() => {
        closed = true;
      });

      // Heartbeat so proxies (and the browser) know the connection is alive.
      // SSE comments (`: keepalive`) are ignored by EventSource but keep the
      // socket from timing out.
      const heartbeatMs = Math.max(config.tailIntervalMs * 20, 5_000);
      let lastHeartbeat = Date.now();

      while (!closed) {
        const batch = eventsQueries.tailEvents(db, since, config.tailBatchSize);
        for (const event of batch) {
          if (event.runId !== branded) continue;
          await stream.writeSSE({
            event: "agent_event",
            id: String(event.seq),
            data: JSON.stringify(event),
          });
          since = event.seq;
        }
        // Only send a heartbeat when there was no actual traffic.
        if (batch.length === 0 && Date.now() - lastHeartbeat >= heartbeatMs) {
          await stream.writeSSE({ event: "heartbeat", data: String(Date.now()) });
          lastHeartbeat = Date.now();
        }
        await sleep(config.tailIntervalMs);
      }
    });
  });

  // --- Static SPA ----------------------------------------------------------
  app.get("/assets/*", async (c) => {
    const path = c.req.path.replace(/^\/assets\//, "");
    return serveStatic(c, join(config.staticDir, "assets", path));
  });

  app.get("/favicon.ico", async (c) => {
    return serveStatic(c, join(config.staticDir, "favicon.ico"), { optional: true });
  });

  // SPA catch-all: any non-API, non-asset GET returns index.html so the
  // SolidJS router can handle client-side routes (e.g. `/run/<id>`).
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "not_found" }, 404);
    return serveStatic(c, join(config.staticDir, "index.html"), { fallbackHtml: FALLBACK_HTML });
  });

  return app;
}

function parseSeq(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

type TryBrandResult =
  | { readonly ok: true; readonly value: ReturnType<typeof brandRunId> }
  | { readonly ok: false };

function tryBrandRunId(raw: string): TryBrandResult {
  try {
    return { ok: true, value: brandRunId(raw) };
  } catch {
    return { ok: false };
  }
}

/**
 * Served when the client bundle hasn't been built yet. Saves the dev from a
 * cryptic 404 — tells them the exact command to run.
 */
const FALLBACK_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>shamu — bundle missing</title></head>
<body style="font-family: system-ui; padding: 2rem; color: #111;">
<h1>Shamu web — client bundle missing</h1>
<p>Run <code>bun run --cwd apps/web build:client</code> to build the SolidJS bundle.</p>
</body>
</html>
`;

interface ServeOptions {
  readonly optional?: boolean;
  readonly fallbackHtml?: string;
}

async function serveStatic(
  c: Context,
  absPath: string,
  opts: ServeOptions = {},
): Promise<Response> {
  try {
    const body = await readFile(absPath);
    const contentType = mimeFor(absPath);
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { "content-type": contentType, "cache-control": "no-store" },
    });
  } catch {
    if (opts.fallbackHtml !== undefined) {
      return new Response(opts.fallbackHtml, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (opts.optional === true) {
      return c.body(null, 204);
    }
    return c.json({ error: "not_found" }, 404);
  }
}

function mimeFor(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}
