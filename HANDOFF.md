# Shamu — Session Handoff

**Last updated:** 2026-04-19 (Phase 7 closed: all tracks landed — 5 adapters, ACP protocol package, egress broker, shared harness, capability matrix, web dashboard MVP. Ready for Phase 8 kickoff.)

Any fresh session starts here. Load the `shamu-dev` skill (`.claude/skills/shamu-dev/SKILL.md`) for the full pipeline; this file is the snapshot of where we are right now.

## TL;DR

Phase 7 is done. All 8 planned tracks (7.A–7.E adapters, 7.G capability matrix, 7.H web dashboard MVP, 7.I egress broker) plus the shared-harness refactor have landed on `main`. The contract suite fans across 8 adapters as a CI matrix job (`contract:<vendor>`) on every PR; `CI / ubuntu-latest` remains the sole branch-protection required check. Echo/claude/codex fake drivers now declare `scriptProbe: true` for fail-loud G4/G5 probes; OpenCode deliberately stays warn-only (SSE-HTTP + per-turn cancel hook doesn't match the shared harness). The web dashboard (`apps/web`) is Hono + SolidJS, 127.0.0.1-bound, reads the CLI's SQLite DB directly, and renders swarm overview + run detail with live SSE tail — MVP only; DAG viz, diff viewer, CI viewer, cost charts are deferred follow-ons. 27 workspace packages. Three live smokes locally runnable (Cursor, OpenCode, Pi); Amp + Gemini still gated on vendor side (paid credits / Google ToS).

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

## What's in flight

Nothing.

## Owed manual steps

- **Rotate OpenCode auth tokens** — during 2026-04-18 live-smoke debugging, `cat ~/.local/share/opencode/auth.json` was executed and the file contents (OpenAI OAuth refresh token, Fireworks key, Zai key, opencode API key) appeared in the conversation. Conversation logs may persist. Rotate at your convenience.

## Phase 8 kickoff

Phase 7 exit criteria met; Phase 8 tracks are now unblocked:

1. **8.A — Autonomous loop** (Parallel). Daemon subscribes to Linear webhooks, picks up `shamu:ready` issues, runs canonical flow. Rate limiter, graceful shutdown, 24h soak test. Gate: G2/G3/G4/G6/G7 all green (they are).
2. **8.B — A2A server** (Parallel with 8.A; v1 scope per 2026-04-18 decision). `packages/protocol/a2a`: Signed Agent Cards + JSON-RPC + SSE + bearer auth. Gate: G11 (A2A trust roots).
3. **8.C — Ops polish** (Serial after 8.A). `shamu doctor`, `bun build --compile` single-binary, Claude 200MB sidecar bootstrap, `shamu ui` command (wires CLI to `apps/web`), screenshot CI, containerized egress enforcement replacing the in-process broker.

Pre-8.A warm-ups (can interleave):
- **Egress-broker adapter wiring** (follow-on from #20) — plumb `createEgressBroker` into `@shamu/core-composition` for per-spawn broker lifecycle + `HTTPS_PROXY`/`HTTP_PROXY` env injection in `SpawnOpts.env`. Small, self-contained, gates 8.A's autonomy posture.
- **`shamu ui` CLI command** (from 7.H followups) — shell out to `apps/web/src/server/index.ts` + `open` the browser. Trivial wire-up; good smoke test of 7.H in anger.

## Followups

### From PR #24 (capability matrix)

1. Type-level exhaustiveness assertion that `CAPABILITY_FEATURE_COLUMNS` covers every `CapabilityFeature`. Today it's a convention + comment.
2. `agent-ci` runner Dockerfile installing `typescript` + `vitest` globally would stop the ~1-in-3 local flake (real GH Actions runs fine).
3. Migrate OpenCode onto `scriptProbe: true` once its SSE cancel hook fits the shared-harness probe shape (already tracked in #21 followups).

### From PR #25 (web dashboard MVP)

1. SolidJS component tests — add JSDOM + `@solidjs/testing-library` to the workspace; cover route rendering, connection-indicator states, event summarization.
2. `shamu ui` CLI command wiring (listed under Phase 8 above).
3. Overview-page live updates — MVP refetches on button-click; a single SSE channel for "new-run" events would keep the overview fresh.
4. Paginate/virtualize the events list for long runs. Naive `<For>` over 10k events will degrade.
5. CSS design-token hoisting to `packages/shared/format` when the TUI lands in Phase 3.

### From PR #20 (egress broker)

1. Adapter wiring follow-on (per-spawn broker + proxy env injection) — see Phase 8 warm-ups above.
2. Escalation-bus integration for `PolicyEgressDeniedEvent` (route into supervisor's escalation channel).
3. TLS interception for payload inspection (Phase 8; per-run CA + subprocess trust-store + MITM rotation).
4. Multi-run single-broker (per-connection policy tag via `Proxy-Authorization`).
5. Shared host-matcher factoring — move `policy.ts`'s decision function into `@shamu/policy` so Phase 8's container enforcer imports the same code.
6. Upstream-proxy chaining for corporate `HTTPS_PROXY`.

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
- `apps/web/` — web dashboard MVP (Hono + SolidJS + SSE; 127.0.0.1-bound).
- `.claude/skills/shamu-dev/SKILL.md` — pipeline.
- `AGENTS.md` / `CLAUDE.md` — GitNexus-generated code context.

## HANDOFF maintenance

Update at phase boundaries (end of Phase N → flip status, refresh "next" section, rotate followups) and at mid-flight session ends (note in-flight agents + half-done files). Keep under ~200 lines. If it grows past that, leak content into PLAN.md.
