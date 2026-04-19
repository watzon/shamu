# Phase 8.C.3 — Web dashboard screenshot CI

Every PR triggers `.github/workflows/screenshots.yml`, which boots the
`@shamu/web` dashboard headlessly against a seeded temp SQLite database,
drives a Playwright-controlled Chromium over a baked-in route list, and
uploads the resulting PNGs as a per-PR build artifact. Reviewers can eyeball
the UI delta without running the app locally.

## What the workflow does

1. `actions/checkout` the PR's head.
2. `oven-sh/setup-bun@v2` pinned to `1.3.11` (mirrors `ci.yml`).
3. `bun install --frozen-lockfile --ignore-scripts` — reproducible install.
4. `bun apps/web/scripts/build-client.ts` — builds the SolidJS bundle into
   `apps/web/dist/public/` so the server has static assets to serve.
5. `bunx -y playwright@1.50.1 install --with-deps chromium` — pre-warms the
   Playwright Chromium cache and installs the required system libraries.
6. `bun scripts/capture-web-screenshots.ts --outdir=./screenshots` — runs
   the capture pipeline.
7. `actions/upload-artifact` uploads `./screenshots/` under the name
   `web-screenshots-<PR number>`; retention 14 days.

The job is **informational only**. Branch protection
(`scripts/setup-branch-protection.sh`) keeps only `CI / ubuntu-latest` as
required, so a transient Playwright download failure never blocks a merge.

## What the capture script does

`scripts/capture-web-screenshots.ts`:

- Creates a temp state directory via `mkdtemp`.
- Calls `startServer({ stateDir, port: 0 })` from `@shamu/web/server` so
  Bun picks a free loopback port.
- Opens a second SQLite connection against the same `shamu.db` and seeds
  it via `seedScreenshotFixtures()` from
  `apps/web/test/helpers/screenshot-seed.ts`. The seed is deterministic:
  one swarm, two runs, ~7 events per run (session_start →
  assistant_message → tool_call → tool_result → fill → usage → turn_end).
- Resolves the route list to `/` plus `/run/<runId>` for each seeded run.
  A caller can override via one or more `--route=<path>` flags.
- For each route, shells out to `npx -y -p playwright@1.50.1 node <driver>`.
  The driver is a short inline ESM script that launches headless Chromium,
  navigates to the URL with `waitUntil: "networkidle"`, and writes a PNG.
- Emits one NDJSON record per event on stdout:

  ```json
  {"kind":"server-ready","url":"http://127.0.0.1:58193"}
  {"kind":"shot","route":"/","path":"/tmp/.../home.png","width":1440,"height":900,"bytes":41230}
  ```

Exit codes:

| Code | Meaning |
|------|---------|
| 0    | All routes captured |
| 2    | Playwright's Chromium isn't installed (soft-fail for local dev) |
| 10   | Server boot or seed failure |
| 20   | Any per-shot failure that isn't a missing-browser error |
| 64   | Bad CLI arguments |

## Running locally

```
bun scripts/capture-web-screenshots.ts --outdir=/tmp/shots
```

Flags:

| Flag                  | Default                   | Notes |
|-----------------------|---------------------------|-------|
| `--outdir=<path>`     | `./screenshots`           | Directory is created if missing. |
| `--viewport=WxH`      | `1440x900`                | Clamped to `[1, 10000]` per axis. |
| `--route=/path`       | `/` + seeded detail pages | Repeatable. Wholly overrides the baked-in list. |
| `--timeout-ms=N`      | `15000`                   | Playwright `goto` / `waitForLoadState` timeout. |

If Playwright isn't installed locally, the script emits a `skip` NDJSON
event and exits 2 rather than failing hard. The GitHub Actions workflow is
the primary capture surface — local runs are for debugging the pipeline.

## Where the PR artifact lands

On a PR's **Checks** tab → pick the `Screenshots` workflow → pick the
`web-dashboard` job → scroll to the bottom for the
`web-screenshots-<PR#>` artifact. Click to download; unzip to get
`home.png` + one `run-<id>.png` per seeded run.

## Tests

- `scripts/capture-web-screenshots.test.ts` — unit-level, uses Bun's native
  test runner. Stubs the browser launcher and server boot via injected
  `CaptureDeps` so the test is hermetic. Invoke with:

  ```
  bun test scripts/capture-web-screenshots.test.ts
  ```

- `apps/web/test/helpers/screenshot-seed.test.ts` — runs under Vitest as
  part of `bun run --cwd apps/web test`; exercised by the main `CI /
  ubuntu-latest` job.

## Known gaps

- **No visual-regression diff** yet. We just upload raw PNGs; a follow-on
  track can compare against a baseline snapshot set.
- **No TUI screenshots.** Phase 8.C.3 is web-only. A future track can teach
  the capture pipeline about the Ink/ANSI rendering output once the TUI
  lands.
- **Single viewport.** `--viewport=WxH` is CLI-overridable but the
  workflow doesn't fan out across sizes; add a matrix entry when
  mobile-width review is useful.
- **Static seed.** The seeded fixture set is deterministic; screenshots
  don't exercise error or empty states. Adding a `--seed=<kind>` flag
  with a handful of canned shapes (empty, error, long-events) is a
  reasonable follow-on.
- **`networkidle` is Playwright's default; SSE reconnect pings can keep
  the signal slow.** The script uses `waitUntil: "networkidle"` plus a
  second `waitForLoadState`, which works today; revisit if a future
  heartbeat change causes flakiness.
