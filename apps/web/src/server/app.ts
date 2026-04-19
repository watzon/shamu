/**
 * Hono application factory.
 *
 * Wiring the app as a pure function (app-factory style) keeps it test-friendly
 * — each test can build a fresh app with an in-memory DB and an isolated set
 * of config overrides. The concrete `main()` in `index.ts` just calls this
 * with the env-derived config.
 *
 * Routes (all under `/api/*` except the SPA):
 *   Read-only (PR #25):
 *     - GET /api/health                      → liveness probe
 *     - GET /api/runs                        → list of RunRow
 *     - GET /api/runs/:id                    → run detail + first page of events
 *     - GET /api/runs/:id/stream             → SSE live-tail, honors Last-Event-ID
 *   Control surface (Phase 9.C):
 *     - GET /api/csrf                        → mint a CSRF token + cookie
 *     - GET /api/adapters/available          → which adapters resolve on this machine
 *     - GET /api/adapters/:vendor/models     → per-adapter model catalog
 *     - POST /api/runs                       → start a new run
 *     - POST /api/runs/:id/interrupt         → cooperative cancel
 *   SPA:
 *     - GET /                                → SolidJS SPA (static HTML)
 *     - GET /assets/*                        → bundled JS/CSS
 *
 * Origin allow-list is enforced as the first middleware. Requests with a
 * missing `Origin` header (curl, fetch on same origin via browser) pass; a
 * mismatched `Origin` returns 403. This is the cross-origin CSRF boundary
 * for the SSE endpoint.
 *
 * Mutating endpoints add a second layer: double-submit CSRF cookie +
 * `X-CSRF-Token` header must match. See `csrf.ts`.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveVendorCli,
  type VendorCliResolverResult,
  type VendorName,
} from "@shamu/adapters-base/vendor-cli-resolver";
import { eventsQueries, runsQueries, type ShamuDatabase } from "@shamu/persistence";
import { runId as brandRunId } from "@shamu/shared/ids";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { ADAPTER_MODULES, isKnownAdapter, knownAdapterNames } from "./adapters.ts";
import type { ServerConfig } from "./config.ts";
import { buildCsrfCookie, CSRF_COOKIE_NAME, mintCsrfToken, validateCsrf } from "./csrf.ts";
import {
  interruptRun as defaultInterruptRun,
  startRun as defaultStartRun,
  type StartRunInput,
  type StartRunResult,
} from "./runs-runner.ts";

export interface AppDeps {
  readonly db: ShamuDatabase;
  readonly config: ServerConfig;
  /** Monotonic clock used to pace the SSE poll loop. Injectable for tests. */
  readonly now?: () => number;
  /** Yield between polls. Injectable so tests can run deterministically. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Test seam: disable the per-run egress broker so unit tests don't have
   * to bind loopback ports. Production leaves this unset (broker enabled).
   */
  readonly skipEgressBroker?: boolean;
  /**
   * Override the run starter. Tests inject a fake to avoid spawning
   * real adapters; production leaves this unset and the default hits
   * `runs-runner.startRun`.
   */
  readonly startRun?: (input: StartRunInput) => Promise<StartRunResult>;
  /**
   * Override the interrupt dispatcher. Same shape — tests stub this to
   * assert the HTTP plumbing without a real handle.
   */
  readonly interruptRun?: (
    runId: ReturnType<typeof brandRunId>,
  ) => Promise<"cancelled" | "unknown">;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function originCheck(origin: string | undefined, allowed: readonly string[]): boolean {
  // No Origin header → same-origin navigation or curl. Allow.
  if (origin === undefined || origin === "") return true;
  return allowed.includes(origin);
}

/** Zod schema for `POST /api/runs` body. */
const startRunBodySchema = z
  .object({
    task: z.string().min(1).max(50_000),
    adapter: z.string().min(1),
    role: z.string().min(1).max(100),
    flow: z.string().optional(),
    model: z.string().optional(),
    // EgressPolicy is loaded server-side; we accept a free-form object
    // and let `loadEgressPolicy` validate inside the broker helper. Keep
    // the outer schema permissive so the frontend can send it as JSON.
    egressPolicy: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

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

  // --- CSRF token ----------------------------------------------------------
  app.get("/api/csrf", (c) => {
    const token = mintCsrfToken();
    c.header("set-cookie", buildCsrfCookie(token));
    return c.json({ token, cookie: CSRF_COOKIE_NAME });
  });

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

  // --- Adapter availability ------------------------------------------------
  app.get("/api/adapters/available", async (c) => {
    const results: Array<{
      readonly vendor: VendorName;
      readonly ok: boolean;
      readonly path?: string;
      readonly source?: string;
      readonly version?: string;
      readonly error?: string;
    }> = [];
    for (const name of knownAdapterNames()) {
      if (name === "echo") continue; // echo has no CLI; excluded per track spec.
      try {
        const descriptor = await ADAPTER_MODULES[name].descriptor();
        const res: VendorCliResolverResult = await resolveVendorCli({
          adapter: name,
          descriptor,
        });
        const entry: {
          vendor: VendorName;
          ok: boolean;
          path?: string;
          source?: string;
          version?: string;
        } = {
          vendor: name,
          ok: true,
          source: res.source,
        };
        if (res.path.length > 0) entry.path = res.path;
        if (res.version !== undefined) entry.version = res.version;
        results.push(entry);
      } catch (err) {
        results.push({
          vendor: name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return c.json({ adapters: results });
  });

  // --- Adapter models ------------------------------------------------------
  app.get("/api/adapters/:vendor/models", async (c) => {
    const vendor = c.req.param("vendor");
    if (!isKnownAdapter(vendor)) return c.json({ error: "unknown_adapter", vendor }, 404);
    try {
      const models = await ADAPTER_MODULES[vendor].models();
      return c.json({ models });
    } catch (err) {
      return c.json(
        {
          error: "models_unavailable",
          vendor,
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  // --- Start a run ---------------------------------------------------------
  app.post("/api/runs", async (c) => {
    const csrf = validateCsrf(c);
    if (!csrf.ok) {
      return c.json({ ok: false, error: "csrf_missing", reason: csrf.reason }, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid_json" }, 400);
    }
    const parsed = startRunBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: "invalid_body",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        400,
      );
    }
    const b = parsed.data;
    if (!isKnownAdapter(b.adapter)) {
      return c.json(
        {
          ok: false,
          error: "unknown_adapter",
          adapter: b.adapter,
          known: knownAdapterNames(),
        },
        400,
      );
    }

    const runInput: StartRunInput = {
      task: b.task,
      adapter: b.adapter,
      role: b.role,
      ...(b.flow !== undefined ? { flow: b.flow } : {}),
      ...(b.model !== undefined ? { model: b.model } : {}),
      // `egressPolicy` passthrough deferred — the frontend doesn't use it
      // in this iteration and `policyFromAllowlist` is the safe default.
    };
    const result = deps.startRun
      ? await deps.startRun(runInput)
      : await defaultStartRun(runInput, {
          db,
          ...(deps.skipEgressBroker === true ? { skipEgressBroker: true } : {}),
        });

    if (result.ok) {
      return c.json({ ok: true, runId: result.runId, url: result.url });
    }
    if (result.code === "vendor-cli-not-found") {
      return c.json(
        {
          ok: false,
          code: result.code,
          adapter: result.adapter,
          checked: result.checked,
          message: result.message,
        },
        400,
      );
    }
    return c.json({ ok: false, code: result.code, message: result.message }, 500);
  });

  // --- Interrupt a run -----------------------------------------------------
  app.post("/api/runs/:id/interrupt", async (c) => {
    const csrf = validateCsrf(c);
    if (!csrf.ok) {
      return c.json({ ok: false, error: "csrf_missing", reason: csrf.reason }, 403);
    }
    const id = c.req.param("id");
    const brandedOrError = tryBrandRunId(id);
    if (brandedOrError.ok === false) return c.json({ ok: false, error: "invalid_run_id" }, 400);
    const status = deps.interruptRun
      ? await deps.interruptRun(brandedOrError.value)
      : await defaultInterruptRun(brandedOrError.value);
    if (status === "unknown") {
      return c.json({ ok: false, error: "run_not_active" }, 404);
    }
    return c.json({ ok: true, status });
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
