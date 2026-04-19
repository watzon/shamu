# @shamu/web

Local-only web dashboard for the Shamu orchestrator. Pairs with the CLI —
reads the same SQLite database, gives you a browser view of the run list and
a live-tailed event stream per run.

## Scope (MVP)

This package ships the Phase 7.H MVP:

- Swarm overview — table of runs (read from `runs` table).
- Run detail — header + chronological event list.
- SSE live tail of the `AgentEvent` stream, reusing the canonical schema from
  `@shamu/shared/events` verbatim.
- Stable `/run/<id>` URLs for bookmarking.

**Deferred** (follow-on PRs): DAG visualization, diff viewer, CI output
viewer, cost/usage charts, supervisor tree view, mailbox inspector.

## Architecture

- **Server.** Hono on Bun's native `Bun.serve`. Bound to `127.0.0.1` only —
  there is no flag to change that in the MVP. No auth, no cookies, no CORS
  beyond a strict `Origin` allow-list (`http://127.0.0.1:<port>` +
  `http://localhost:<port>`).
- **Storage.** Read-only against the CLI's canonical SQLite database at
  `$SHAMU_STATE_DIR/shamu.db` (default `./.shamu/state/shamu.db`). No
  separate store.
- **Transport for live data.** Server-Sent Events — one-way push, browser
  `EventSource`, Last-Event-ID resumes on reconnect. The server polls the
  `events` table via `eventsQueries.tailEvents` on a 250ms cadence by
  default; payload is the untouched `AgentEvent` serialized to JSON.
- **Frontend.** SolidJS + `@solidjs/router`. No CSS framework; design tokens
  live as CSS custom properties in `src/frontend/styles.css`.

### Why Hono + SolidJS

Hono is Bun-native, small, and has a first-class SSE helper
(`hono/streaming`). SolidJS's fine-grained reactivity is a clean fit for a
constantly-updating event stream — no virtual-DOM tax, no reconciler chatter
on every new event.

## Running locally

From the repo root:

```sh
# build the client bundle + start the server
bun run --cwd apps/web dev

# or, in two steps:
bun run --cwd apps/web build        # builds dist/public/
bun run --cwd apps/web src/server/index.ts
```

The server prints its listening URL (default `http://127.0.0.1:4711`).

### Environment variables

| var               | default                       | purpose                                         |
| ----------------- | ----------------------------- | ----------------------------------------------- |
| `SHAMU_WEB_PORT`  | `4711`                        | Override the listening port (1–65535).          |
| `SHAMU_STATE_DIR` | `./.shamu/state`              | Directory holding `shamu.db` (mirrors the CLI). |

## API

All routes return JSON and live under `/api/*`.

| method + route                  | purpose                                                          |
| ------------------------------- | ---------------------------------------------------------------- |
| `GET /api/health`               | liveness probe; returns `{ok, dbPath}`.                          |
| `GET /api/runs`                 | `{ runs: RunRow[] }` — list of runs, newest first.               |
| `GET /api/runs/:id`             | `{ run, events }` — run row + full event history.                |
| `GET /api/runs/:id/stream`      | SSE stream of `AgentEvent`s. Honors `Last-Event-ID` for resume.  |

The SSE stream emits `event: agent_event` messages with `id: <seq>` and the
full JSON-encoded `AgentEvent` as `data:`. Heartbeat `event: heartbeat`
messages are sent every ~5s of idle time to keep browsers / intermediary
proxies from closing the socket.

## Tests

```sh
bun run --cwd apps/web test
```

Server routes are exercised via `app.fetch(Request)` against an in-memory
fake `ShamuDatabase` (see `test/helpers/fake-db.ts`). No real HTTP listener
is started.

## Build pipeline

- **Server.** Run directly via `bun src/server/index.ts`. Bun resolves
  workspace packages (`@shamu/persistence`, `@shamu/shared`) at runtime —
  no separate bundle step for the server.
- **Client.** `scripts/build-client.ts` uses `Bun.build` + `bun-plugin-solid`
  to compile the SolidJS SPA into `dist/public/assets/index.js`. The server
  serves `dist/public/` as static files; an SPA catch-all returns
  `index.html` so the `@solidjs/router` handles client-side routes.
