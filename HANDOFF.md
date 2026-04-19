# Shamu — Session Handoff

**Last updated:** 2026-04-19 (Phase 8 warm-ups landed: egress-broker composition wiring + `shamu ui` CLI command. Ready for Phase 8.A + 8.B.)

Any fresh session starts here. Load the `shamu-dev` skill (`.claude/skills/shamu-dev/SKILL.md`) for the full pipeline; this file is the snapshot of where we are right now.

## TL;DR

Phase 7 is done; both pre-8.A warm-ups have landed. `SpawnOpts.env` is now part of the adapter contract (threaded through every subprocess-owning adapter; OpenCode + echo accept-and-ignore by documentation). `@shamu/core-composition` exports `withEgressBroker({ policy, baseSpawnOpts, onEvent? })` — one call spins up a per-run broker, merges `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` onto SpawnOpts, and returns an idempotent `shutdown()`. `shamu ui` is now real: it boots `@shamu/web`'s server in-process, opens the browser, and exits cleanly on SIGTERM. Phase 8.A autonomy posture is unblocked (broker is one call away) and Phase 7.H has a user-facing entrypoint. 27 workspace packages. The contract suite still fans across 8 adapters as a CI matrix (`contract:<vendor>`) on every PR; `CI / ubuntu-latest` remains the sole branch-protection required check. Three live smokes locally runnable (Cursor, OpenCode, Pi); Amp + Gemini still gated on vendor side (paid credits / Google ToS).

## Key commits

- #13 7.A OpenCode (SSE-HTTP ref + shared contract-test harness)
- #14 7.B Cursor ACP ref + `@shamu/protocol-acp`
- #15 7.C Gemini ACP variation
- #16 7.D Amp stream-JSON-shell
- #17 7.E Pi custom-JSONL
- #18 fix: default `mcpServers: []` on ACP `session/new`+`session/load`
- #19 chore: OpenCode + Pi provider/model vendorOpts + OpenCode shutdown-timeout guard
- #20 7.I `@shamu/egress-broker`
- #21 chore: shared ACP/stream adapter harness
- #23 skill(shamu-dev): tighten parallel-agent git-safety rules
- #24 7.G capability matrix + CI adapter fan-out + scriptProbe migration
- #25 7.H web dashboard MVP (`@shamu/web`)
- #27 chore: wire `shamu ui` to `@shamu/web` + open browser
- #28 chore: wire `@shamu/egress-broker` into `@shamu/core-composition`

## Status

| Phase | Scope | Status |
|-------|-------|--------|
| 0–6 | (prior) | ✅ |
| 7.A | OpenCode | ✅ (#13) |
| 7.B | Cursor + protocol-acp | ✅ (#14) |
| 7.C | Gemini | ✅ (#15) |
| 7.D | Amp | ✅ (#16) |
| 7.E | Pi | ✅ (#17) |
| 7.F | Kimi | deferred to Phase 7.X |
| 7.G | Capability matrix | ✅ (#24) |
| 7.H | Web dashboard MVP | ✅ (#25) |
| 7.I | Egress broker | ✅ (#20) |
| Shared harness refactor | Cursor/Gemini/Amp/Pi → `@shamu/adapters-base` | ✅ (#21) |
| Post-7.A-E fix PRs | #18 #19 | ✅ |
| Pre-8.A warm-up | Egress-broker composition wiring + SpawnOpts.env | ✅ (#28) |
| Pre-8.A warm-up | `shamu ui` CLI command | ✅ (#27) |

## What's in flight

Nothing.

## Owed manual steps

- **Rotate OpenCode auth tokens** — during 2026-04-18 live-smoke debugging, `cat ~/.local/share/opencode/auth.json` was executed and the file contents (OpenAI OAuth refresh token, Fireworks key, Zai key, opencode API key) appeared in the conversation. Conversation logs may persist. Rotate at your convenience.

## Phase 8 kickoff

Warm-ups cleared (#27 + #28); Phase 8 tracks are fully unblocked:

1. **8.A — Autonomous loop** (Parallel). Daemon subscribes to Linear webhooks, picks up `shamu:ready` issues, runs canonical flow. Rate limiter, graceful shutdown, 24h soak test. Broker wiring now composable via `withEgressBroker` in `@shamu/core-composition`. Gate: G2/G3/G4/G6/G7 all green.
2. **8.B — A2A server** (Parallel with 8.A; v1 scope per 2026-04-18 decision). `packages/protocol/a2a`: Signed Agent Cards + JSON-RPC + SSE + bearer auth. Gate: G11 (A2A trust roots).
3. **8.C — Ops polish** (Serial after 8.A). `shamu doctor` extensions, `bun build --compile` single-binary, Claude 200MB sidecar bootstrap, screenshot CI, containerized egress enforcement replacing the in-process broker, real `--unsafe-bind` plumb-through + auth on the web dashboard. (`shamu ui` CLI wiring itself landed in #27; remaining 8.C UX polish is the non-loopback host story.)

## Followups

### From PR #24 (capability matrix)

1. Type-level exhaustiveness assertion that `CAPABILITY_FEATURE_COLUMNS` covers every `CapabilityFeature`. Today it's a convention + comment.
2. `agent-ci` runner Dockerfile installing `typescript` + `vitest` globally would stop the ~1-in-3 local flake (real GH Actions runs fine).
3. Migrate OpenCode onto `scriptProbe: true` once its SSE cancel hook fits the shared-harness probe shape (already tracked in #21 followups).

### From PR #25 (web dashboard MVP)

1. SolidJS component tests — add JSDOM + `@solidjs/testing-library` to the workspace; cover route rendering, connection-indicator states, event summarization.
2. Overview-page live updates — MVP refetches on button-click; a single SSE channel for "new-run" events would keep the overview fresh.
3. Paginate/virtualize the events list for long runs. Naive `<For>` over 10k events will degrade.
4. CSS design-token hoisting to `packages/shared/format` when the TUI lands in Phase 3.

### From PR #27 (`shamu ui` CLI command)

1. `--unsafe-bind` is still documentation-only — real non-loopback support needs widened `ServerConfig.host` + auth + a Phase 8.C escape-hatch UX.
2. Browser auto-launch is darwin + linux only; other platforms get a "please open manually" diag. Matches `shamu doctor`'s supported-platform set.
3. `startServer` returns `{ url, server, config, stop }`. Later callers may want `ready` signals (SSE subscriber count, hot-reload hooks); not needed for current scope.

### From PR #28 (egress-broker composition wiring)

1. OpenCode SDK `ServerOptions.env` — thread `opts.env` through once upstream grows the field. Today OpenCode accepts-and-ignores with a documented no-op.
2. Escalation-bus integration for `PolicyEgressDeniedEvent` (route into supervisor's escalation channel) — now trivially composable via `withEgressBroker`'s `onEvent` → `createEscalationEmitter`. Deferred to 8.A scope.
3. `mergeCallerEnv` helper duplicated across five adapters (Cursor/Gemini/Amp/Pi + Claude/Codex variants). Could DRY into `@shamu/adapters-base` if a future phase adds another adapter; not worth the export-surface churn this track.

### From PR #20 (egress broker — still open)

1. TLS interception for payload inspection (Phase 8; per-run CA + subprocess trust-store + MITM rotation).
2. Multi-run single-broker (per-connection policy tag via `Proxy-Authorization`).
3. Shared host-matcher factoring — move `policy.ts`'s decision function into `@shamu/policy` so Phase 8's container enforcer imports the same code.
4. Upstream-proxy chaining for corporate `HTTPS_PROXY`.

### From PR #21 (shared harness)

1. Tighten `SessionId | null` handling — prompt/cancelSession call sites still cast `as SessionId`.
2. Migrate OpenCode onto the harness once its SSE cancel hook fits `runShutdownSequence.drainStream`.
3. Simplify `AdapterEventQueue<E>` → `AgentEvent` only (generic currently unused).
4. Drop `PromptWatchdog.isArmed()` if no caller materializes by Phase 8.
5. `AgentEventKind` exhaustiveness test for `redactAgentEvent` (compile-time only today).

### From 7.C (still open)

- **`Capabilities.setModel` proper field** (`"per-session" | "subagent" | "none"`) once Gemini's `unstable_setSessionModel` graduates upstream.

### From 7.D (still open)

- Verify `formatUserTurn()` stdin shape once a dev machine can run live Amp.
- In-stream cancel message for Amp when upstream adds one.
- Stderr routing via `vendorOpts.verbose: true` → `stderr` AgentEvents.

### From 7.E (still open)

- `@shamu/shared/credentials` integration for Pi auth (`resolvePiAuth`).
- Real usage + cost via `get_session_stats` on Pi `turn_end` (today: zeroed).
- `tool_execution_update` progress → `stdout` events if useful.

### From Phase 6.C.3 (still open — Phase 8.A targets)

- Auto-attach PR URL from flow output.
- CI-tripwire runId ↔ pickup runId mismatch.
- Persistent registry + rolling-comment state.
- Rate-limited concurrent pickups.
- Graceful drain-on-shutdown.
- 24-hour soak test.
- Retry loop in escalation sink (honor `retryAfterSeconds`).
- Bounded-queue back-pressure for pickup driver.

### From Phase 6.C.2 / 6.A / Phase 5 (still open — carried)

- `AgentSessionEvent` subscription in typed webhook union.
- Live cloudflared smoke (`SHAMU_LINEAR_LIVE=1`).
- OAuth 2.1 DCR against `mcp.linear.app/mcp` (multi-tenant story).
- Rate-limit shape monitoring.
- Artifact capture to SQLite.
- Redactor pass on CI excerpts.
- Agent-ci programmatic abort.
- Richer live gate smoke.

### Vendor / environment

- **Amp** — vendor requires paid credits for non-interactive `amp -x`; our wire projection is correct but live-smoke can't validate end-to-end until paid.
- **Gemini** — user's Google account flagged ToS-disabled; appeal needed before live-smoke can complete.
- **`apps/cli/.shamu-flow-shim/` accumulation** — long-lived daemon needs a prune or TTL (Phase 8.A).
- **Infrequent `agent-ci` flake** — ~1-in-3 failures observed locally; `check` job's container lacks `tsc`/`vitest` globally. Add a runner Dockerfile to stop the false red.

## Open questions

None blocking.

## Already-answered decisions

- **Phase 7 adapter transport decisions** (2026-04-18) — full list in PLAN.md "Decisions captured from user".
- **Shared harness approach** — B+A hybrid at `packages/adapters/base/src/harness.ts`. OpenCode excluded (two-stage SSE drain + per-turn cancel hook don't match).
- **Egress-broker policy format** — JSON; `defaultPolicy`/`allowedHosts`/`allowedHostSuffixes`/`egressLogPath`. Shared with Phase 8 containerized enforcement (same `loadEgressPolicy` + pure `matchHost`).
- **Web dashboard MVP scope (2026-04-19)** — Hono + SolidJS + SSE + stable `/run/<id>` URLs. DAG viz, diff viewer, CI viewer, cost charts explicitly deferred to follow-ons. `--unsafe-bind` UX deferred to Phase 8.C.
- **CI adapter matrix is additive** — `contract:<vendor>` jobs are NOT branch-protection required; only `CI / ubuntu-latest` is. Adapter adds/removes don't need a protection update.

## Pointers

- `PLAN.md` — architecture + phased delivery + decisions.
- `docs/phase-7/adapter-transports.md` — per-adapter transport classification.
- `docs/phase-7/capability-matrix.md` — generated "which adapter supports what" (regenerate via `bun scripts/generate-capability-matrix.ts`).
- `packages/adapters/base/src/harness.ts` — shared ACP/stream handle machinery.
- `packages/adapters/base/src/capability-matrix.ts` — matrix generator (pure module).
- `packages/adapters/{cursor,gemini,amp,pi}/src/handle.ts` — thin vendor-specific deltas on the harness.
- `packages/adapters/opencode/` — outlier; NOT on the shared harness.
- `packages/egress-broker/` — network policy proxy.
- `packages/core/composition/src/with-egress-broker.ts` — helper that spins up a per-run broker + merges proxy env onto SpawnOpts (Phase 8.A entry point).
- `apps/web/` — web dashboard MVP (Hono + SolidJS + SSE; 127.0.0.1-bound). `startServer()` exported for CLI embedding.
- `apps/cli/src/commands/ui.ts` — `shamu ui` CLI command (boots `@shamu/web` in-process, launches browser).
- `.claude/skills/shamu-dev/SKILL.md` — pipeline.
- `AGENTS.md` / `CLAUDE.md` — GitNexus-generated code context.

## HANDOFF maintenance

Update at phase boundaries (end of Phase N → flip status, refresh "next" section, rotate followups) and at mid-flight session ends (note in-flight agents + half-done files). Keep under ~200 lines. If it grows past that, leak content into PLAN.md.
