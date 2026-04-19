# Phase 9.B.1 — Codex live smoke

Track: 9.B.1 (`shamu run --adapter codex --task "hello"` live smoke + fix).
Branch: `shamu/phase/9b1-codex-smoke`. Pairs with `PLAN.md` line 834 and
`packages/adapters/codex/`.

## Environment

| Item | Value |
|------|-------|
| OS | macOS 15.4 (darwin 25.4.0, arm64) |
| Bun | 1.3.11 |
| Node | 24.3.0 |
| Codex CLI | 0.121.0 @ `/opt/homebrew/bin/codex` |
| `@openai/codex-sdk` | 0.121.0 (pinned in `packages/adapters/codex/package.json`) |
| Auth — Path A | ChatGPT-OAuth via `~/.codex/auth.json` (`auth_mode: chatgpt`) |
| Auth — Path B | `CODEX_API_KEY` — **not set in this environment** |
| Resolver | `shamu doctor --resolve-clis` → `codex /opt/homebrew/bin/codex (source=candidate)` |

## Invocation

### Path A — ChatGPT-OAuth (`--codex-cli` / resolver)

```
mkdir -p /tmp/sc-a && cd /tmp/sc-a
bun apps/cli/src/index.ts run \
  --adapter codex \
  --task "Reply with exactly the word pong." \
  --codex-cli /opt/homebrew/bin/codex \
  --state-dir /tmp/sc-a/.shamu \
  --json
```

Equivalent without `--codex-cli` uses the shared resolver to pick the same
`/opt/homebrew/bin/codex`.

### Path B — `CODEX_API_KEY` (API-mode)

```
CODEX_API_KEY="$KEY" bun apps/cli/src/index.ts run \
  --adapter codex \
  --task "Reply with exactly the word pong." \
  --state-dir /tmp/sc-b/.shamu \
  --json
```

## Outcome

| Path | Outcome | Notes |
|------|---------|-------|
| A — ChatGPT-OAuth | **success** | Full `session_start → assistant_message("pong") → usage → cost → turn_end(stopReason=completed)` event sequence. Exit 0. End-to-end latency ~6–9s against gpt-5-codex (default). Repeated three times across git-init + non-git cwds. |
| B — `CODEX_API_KEY` | **blocked-on-env** | No `CODEX_API_KEY` available in the test machine's environment. `resolveCodexAuth` path B is proven by the adapter unit suite (`test/unit/auth.test.ts` — 7 tests) which covers precedence + both branches with an injected env map. No end-to-end API-key smoke captured; defer to a follow-on session where the key is available. |

## Evidence — Path A

Initial live-smoke invocation (before fix, cwd = `/tmp/shamu-codex-nogit-*` without `git init`):

```
run 01KPKSDERFSNSEDJNGS9MMWF0P started (adapter=codex role=executor)
# total elapsed: 0.25s. zero events emitted. exit 0. iterator silently closed.
```

Post-fix re-run (same non-git cwd):

```
{"kind":"run-started","runId":"01KPKSJQ...","adapter":"codex","role":"executor"}
{"kind":"session_start","source":"spawn","sessionId":"019da799-6141-..."}
{"kind":"assistant_message","text":"pong","stopReason":"end_turn"}
{"kind":"usage","model":"codex-default","tokens":{"input":55778,"output":5,"cacheRead":55680}}
{"kind":"cost","usd":null,"confidence":"unknown","source":"subscription"}
{"kind":"turn_end","stopReason":"completed","durationMs":8401}
{"kind":"run-cost","tokens":{"input":55778,"output":5,"cacheRead":55680,"cacheCreation":0},"cost":{"usdTotal":0,"confidenceBreakdown":{"exact":0,"estimate":0,"unknown":1},"subscriptionRuns":1}}
# total elapsed: 9.4s, exit 0.
```

`shamu doctor --resolve-clis` output for Codex (post-9.A, unchanged):

```
  vendor CLIs:
    ok   codex       /opt/homebrew/bin/codex (source=candidate)
```

`--dry-run` wiring through the resolver:

```
$ bun apps/cli/src/index.ts run --adapter codex --task hello --dry-run
run validated: adapter=codex role=executor
  task: hello
  cli: /opt/homebrew/bin/codex (source=candidate)
```

Model rejection path (Codex server refuses `gpt-5` under ChatGPT-OAuth — proves
`--model` is threaded):

```
--model gpt-5 → {"kind":"error","fatal":true,"errorCode":"stream_error","message":"...The 'gpt-5' model is not supported when using Codex with a ChatGPT account."}
# turn_end(stopReason=failed), exit 0, event stream drained cleanly.
```

Automated live test (gated on `SHAMU_CODEX_LIVE=1`):

```
SHAMU_CODEX_LIVE=1 SHAMU_CODEX_CLI=/opt/homebrew/bin/codex \
  bun run --cwd packages/adapters/codex test
...
 ✓ test/live/live.test.ts (2 tests) 13128ms
     ✓ spawn + simple turn reaches turn_end with stopReason=completed  7802ms
     ✓ completes in a non-git cwd (skipGitRepoCheck regression guard)  5325ms

 Test Files  9 passed (9)
      Tests  77 passed (77)
```

## Defects

### D1 — Non-trusted cwd hangs forever with no error signal (FIXED)

**Symptom.** `shamu run --adapter codex` in any directory the local Codex CLI
does not consider a trusted git repo exited 0 in ~0.25s with zero streamed
events, zero persisted rows, and no diagnostic. The adapter's `handle.events`
async iterator never closed — the CLI process exited only because the
underlying Bun event loop had no handles keeping it alive.

**Root cause.** Two layered bugs:

1. The Codex CLI (`codex exec --experimental-json`) defaults to a
   "trusted-directory" check. In a non-git / non-trusted cwd it prints
   `Not inside a trusted directory and --skip-git-repo-check was not
   specified.` on **stdout** and exits **0**. The SDK's readline loop
   yields zero JSONL events, the exit-code check passes, and the
   generator returns cleanly with no ThreadEvent ever produced.
2. `CodexHandle.runTurn` assumed the SDK would always open a turn before
   failing. `enqueueError` and `emitSyntheticTurnEnd` both guarded on an
   open envelope; when the SDK returned zero events, no turn was ever
   opened, both helpers silently no-op'd via inner try/catch, and the
   event queue never received a `close()`. The consumer's `for await`
   was left waiting on a Promise sitting in `CodexEventQueue.waiters[]`
   with no I/O keeping the loop alive.

**Fix.** Three coordinated changes under
`packages/adapters/codex/src/`:

- `index.ts` — `CodexAdapter.threadOptions` now sets
  `skipGitRepoCheck: true` on every Thread. The orchestrator owns the
  worktree (tmpdirs, Linear shim worktrees, container mounts); Codex's
  own git-repo-check is redundant with shamu's path-scope / shell-gate.
- `handle.ts` — new `ensureSyntheticFrame()` helper opens a synthetic
  `session_start` + turn when the projector has not seen real events.
  Both `enqueueError` and `emitSyntheticTurnEnd` now call it, so
  pre-first-event failures always produce a valid error envelope and a
  terminal `turn_end` that closes the iterator.
- `handle.ts` — explicit `vendor_empty_stream` error + synthetic tail
  when the SDK generator finishes with zero events, so operators get an
  actionable error message rather than a silent exit-0.

**Regression guards:**

- Two new unit tests in `test/unit/handle.test.ts`:
  `empty-stream guard (Phase 9.B.1) → emits synthetic session_start +
  error + turn_end when the SDK yields zero events` and
  `... → emits synthetic error + turn_end when the SDK throws before
  thread.started`.
- One new unit test asserting `skipGitRepoCheck: true` is passed to
  `ThreadOptions`.
- Two new live tests (`test/live/live.test.ts`) — one stock, one in an
  explicitly non-git tmpdir. Both gated on `SHAMU_CODEX_LIVE=1`.

### D2 — Live test harness was shipped as `.test.ts.skip`

The live test file was stored as `test/live/live.test.ts.skip` to keep it
out of Vitest's default collection — but the `.skip` suffix is a brittle
convention that doesn't match the project's other adapter-live-test
patterns and couldn't be run with a simple env var toggle. The file
itself was also untouched since Phase 6.

**Fix.** Renamed to `test/live/live.test.ts` and gated at the
`vitest.config.ts` level: `exclude` now filters `test/live/**` when
`SHAMU_CODEX_LIVE !== "1"`. In-test `describe.skip` remains a belt-and-
suspenders gate for CI. New assertions cover both the happy-path
`stopReason=completed` claim and the non-git cwd regression guard.

### D3 — `CODEX_API_KEY` path unproven end-to-end (DEFERRED)

Path B was not exercised live in this session — the testing environment
has no `CODEX_API_KEY`. Unit coverage (`test/unit/auth.test.ts`) proves
precedence and the API-key branch via an injected env map, and the
`shamu doctor --resolve-clis` output confirms the CLI resolver is
orthogonal to the auth path, but there is no captured evidence that
`resolveCodexAuth({}) → { path: "api-key", apiKey }` → `new Codex({
apiKey })` → end-to-end turn_end works against real OpenAI billing.

**Defer.** Mark this open until a session with a valid `CODEX_API_KEY`
can rerun the same smoke sequence without `--codex-cli`. Estimated
5-minute task once the key is available; no adapter code changes
expected.

### D4 — `resolveCodexAuth` silently drops a stray `CODEX_API_KEY` when `vendorCliPath` is present (INTENDED)

Documented in `auth.ts` module-doc: when both are supplied the CLI path
wins and the env var is dropped so the user is not silently upgraded to
API billing. Verified by `test/unit/auth.test.ts` — no action needed,
called out here so the digest step doesn't re-file this as a defect.

## Defer list

- **D3 — Path B live smoke.** Requires `CODEX_API_KEY`. Single five-minute
  session when the key is available; no code changes expected.
- **Stderr surface.** The SDK's `CodexExec.run()` captures stderr only to
  include in its exit-code-nonzero error message; on the zero-exit
  empty-stream path stderr is discarded. A richer diag path
  (`stderr → stdout AgentEvents` or a broker seam) would give operators
  more context on why a CLI refused. Out of scope for 9.B.1; a
  follow-on can thread a `stderrHook` through the SDK fork or expose
  `CodexExec` directly.
- **Doctor auth-probe deepening.** `VendorCliAuthProbe` is declared on
  the descriptor shape (`base/src/vendor-cli-resolver.ts`) but not
  executed today. A `shamu doctor --resolve-clis --deep` pass that runs
  `codex whoami` or equivalent would catch "CLI is installed but not
  signed in" before the run. Listed in the Phase 9.A follow-ons; not
  9.B.1 scope.
- **`approvalPolicy`/`sandboxMode` plumbing.** Current wiring maps
  `permissionMode` to `approvalPolicy: "on-request"` (default) or
  `"never"` + `sandboxMode: "workspace-write"` (`acceptEdits`). The
  Codex CLI supports additional granularity (`sandboxMode:
  "danger-full-access"`, `"read-only"`) that the adapter does not
  surface. Defer until the supervisor has a permission model that
  demands the extra shape.

## Gate outputs

```
bun run lint        # clean
bun run typecheck   # clean
bun run test        # 77 tests pass (codex), N total across workspace (see Hand-off)
bun run agent-ci    # clean
```

Details captured in the PR hand-off.

## Files touched

- `packages/adapters/codex/src/handle.ts` — `runTurn` empty-stream guard;
  `ensureSyntheticFrame()`; `enqueueError` / `emitSyntheticTurnEnd`
  auto-open.
- `packages/adapters/codex/src/index.ts` — `threadOptions.skipGitRepoCheck = true`.
- `packages/adapters/codex/test/unit/handle.test.ts` — three new tests.
- `packages/adapters/codex/test/live/live.test.ts` — renamed from
  `.test.ts.skip`; added non-git cwd regression test.
- `packages/adapters/codex/vitest.config.ts` — conditional `test/live/**`
  exclude keyed off `SHAMU_CODEX_LIVE`.
- `docs/phase-9/smoke-codex.md` — this document.
