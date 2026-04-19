# Shamu — Session Handoff

**Last updated:** 2026-04-19 (Phase 7 major tracks complete: 5 adapters + `@shamu/protocol-acp` + `@shamu/egress-broker` + shared harness refactor. Remaining: 7.G capability matrix, 7.H web dashboard.)

Any fresh session starts here. Load the `shamu-dev` skill (`.claude/skills/shamu-dev/SKILL.md`) for the full pipeline; this file is the snapshot of where we are right now.

## TL;DR

All five Phase 7 adapters landed (OpenCode, Cursor, Gemini, Amp, Pi). `@shamu/protocol-acp` covers Cursor + Gemini; `@shamu/egress-broker` closes the G2 threat-model gap that blocks the Phase 8 autonomous daemon. A post-E refactor consolidated ~90% duplication across Cursor/Gemini/Amp/Pi into `packages/adapters/base/src/harness.ts` (AdapterHandleBase + composable helpers) — 1086 lines removed across the four adapters, 702 added in shared harness, net −384. OpenCode is deliberately excluded from the harness (two-stage SSE drain + per-turn cancel hook). Three live smokes runnable locally (Cursor, OpenCode, Pi); Amp blocked by vendor paid-credits wall; Gemini blocked by user's Google account ToS. 26 workspace packages; contract suite runs 17 × 5 = 85 scenarios with fail-loud G4/G5 probes on four of five adapters (OpenCode stays warn-only as 7.G prep).

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
| 7.G | Capability matrix | ⬜ (unblocked) |
| 7.H | Web dashboard | ⬜ |
| 7.I | Egress broker | ✅ (#20) |
| Shared harness refactor | Cursor/Gemini/Amp/Pi → `@shamu/adapters-base` | ✅ (#21) |
| Post-7.A-E fix PRs | #18 #19 | ✅ |

## What's in flight

Nothing.

## Owed manual steps

- **Rotate OpenCode auth tokens** — during 2026-04-18 live-smoke debugging, `cat ~/.local/share/opencode/auth.json` was executed and the file contents (OpenAI OAuth refresh token, Fireworks key, Zai key, opencode API key) appeared in the conversation. Conversation logs may persist. Rotate at your convenience.

## Phase 7 next steps

1. **7.G — Capability matrix + docs** (serial after A–E; now unblocked). Generate matrix from each adapter's `capabilities.json`; run contract suite as a parallel CI matrix job against all five adapters; write "Which adapter supports what" docs page. Doc-heavy, low-risk.
2. **7.H — Web dashboard** (parallel; big scope). Per the earlier decision, scope to **MVP only**: swarm overview + run detail + SSE subscription + stable `/run/<id>` URLs. DAG viz + diff viewer + cost charts deferred to follow-on PRs. Hono (Bun-native HTTP) + SolidJS; 127.0.0.1-bound.
3. **Egress-broker adapter wiring (follow-on)** — plumb `createEgressBroker` into `@shamu/core-composition` for per-spawn broker lifecycle + `HTTPS_PROXY`/`HTTP_PROXY` env injection in `SpawnOpts.env`.

## Followups

### From PR #20 (egress broker)

1. Adapter wiring follow-on (per-spawn broker + proxy env injection).
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

### From 7.A (still open)

- **Migrate echo/claude/codex/opencode fake drivers to `scriptProbe: true`** for fail-loud G4/G5 probes. 7.G prep — ~20 lines per adapter.

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
- **Infrequent `agent-ci` flake** — ~1-in-3 failures observed during cleanup PR #11; probably Docker reap race. Add retry if recurring.

## Open questions

None blocking.

## Already-answered decisions

- **Phase 7 adapter transport decisions** (2026-04-18) — full list in PLAN.md "Decisions captured from user".
- **Shared harness approach** — B+A hybrid at `packages/adapters/base/src/harness.ts`. OpenCode excluded (two-stage SSE drain + per-turn cancel hook don't match).
- **Egress-broker policy format** — JSON; `defaultPolicy`/`allowedHosts`/`allowedHostSuffixes`/`egressLogPath`. Shared with Phase 8 containerized enforcement (same `loadEgressPolicy` + pure `matchHost`).

## Pointers

- `PLAN.md` — architecture + phased delivery + decisions.
- `docs/phase-7/adapter-transports.md` — per-adapter transport classification.
- `packages/adapters/base/src/harness.ts` — shared ACP/stream handle machinery.
- `packages/adapters/{cursor,gemini,amp,pi}/src/handle.ts` — thin vendor-specific deltas.
- `packages/adapters/opencode/` — outlier; NOT on the shared harness.
- `packages/egress-broker/` — network policy proxy.
- `.claude/skills/shamu-dev/SKILL.md` — pipeline.
- `AGENTS.md` / `CLAUDE.md` — GitNexus-generated code context.

## HANDOFF maintenance

Update at phase boundaries (end of Phase N → flip status, refresh "next" section, rotate followups) and at mid-flight session ends (note in-flight agents + half-done files). Keep under ~200 lines. If it grows past that, leak content into PLAN.md.
