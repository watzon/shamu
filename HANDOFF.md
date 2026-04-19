# Shamu — Session Handoff

**Last updated:** 2026-04-19 (Phase 8 complete: 8.A autonomous loop + 8.B A2A v1 + all five 8.C sub-tracks landed. Two owed manual steps: 24h soak on staging Linear + signed single-binary release.)

Any fresh session starts here. Load the `shamu-dev` skill (`.claude/skills/shamu-dev/SKILL.md`) for the full pipeline; this file is the snapshot of where we are right now.

## TL;DR

**Phase 8 is done.** Autonomous Linear-driven daemon with bounded concurrency + graceful drain + per-run egress broker (8.A); A2A v1 protocol package with Signed Agent Cards + JSON-RPC + SSE + bearer tokens bound to issuer DIDs (8.B); `shamu doctor` extended with audit-chain verify + broker reachability + NTP clock-skew + webhook probe + cloudflared tunnel scope (8.C.1); `bun build --compile` release path + Claude sidecar bootstrap (8.C.2); web-dashboard screenshot CI per PR (8.C.3); rewritten README + architecture diagram + CONTRIBUTING + threat-model summary (8.C.4); opt-in Docker-backed egress broker with hard isolation (8.C.5). 29 workspace packages. `CI / ubuntu-latest` remains the sole branch-protection required check; `macos-latest` and all `contract:<vendor>` jobs are additive.

Two owed manual steps: 24-hour autonomous soak against a staging Linear project (infrastructure + ops doc shipped at `docs/phase-8/soak-test.md`; user owns webhook + credentials); signed single-binary release (build script + sidecar bootstrap ready at `scripts/build-release.ts`; user owns Apple Developer ID signing cert).

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
- #30 Phase 8.B: `@shamu/protocol-a2a` (A2A v1 server + client)
- #31 Phase 8.A: autonomous loop — rate limit + drain + soak + broker
- #32 chore: thread `SpawnOpts.env` through flow runner (closes 8.A no-op)
- #33 Phase 8.C.4: README + architecture + CONTRIBUTING + threat-model
- #34 Phase 8.C.1: `shamu doctor` extensions
- #35 Phase 8.C.3: screenshot CI for web dashboard
- #36 Phase 8.C.2: single-binary release + Claude sidecar bootstrap
- #37 Phase 8.C.5: `@shamu/egress-broker-container` (opt-in hard isolation)

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
| 8.A | Autonomous loop (rate limit + drain + soak + broker) | ✅ (#31, env-passthrough #32) |
| 8.B | A2A v1 server + client | ✅ (#30) |
| 8.C.1 | `shamu doctor` extensions | ✅ (#34) |
| 8.C.2 | Single-binary release + Claude sidecar | ✅ (#36) |
| 8.C.3 | Screenshot CI for web dashboard | ✅ (#35) |
| 8.C.4 | Docs — README + architecture + CONTRIBUTING + threat-model | ✅ (#33) |
| 8.C.5 | Container-based egress enforcement (opt-in) | ✅ (#37) |

## What's in flight

Nothing.

## Owed manual steps

- **Rotate OpenCode auth tokens** — during 2026-04-18 live-smoke debugging, `cat ~/.local/share/opencode/auth.json` was executed and the file contents (OpenAI OAuth refresh token, Fireworks key, Zai key, opencode API key) appeared in the conversation. Conversation logs may persist. Rotate at your convenience.

## What's next

Phase 8 is closed. Code-level exit criteria met; two owed manual steps remain:

1. **24-hour autonomous soak** on a staging Linear project. Infrastructure ready at `apps/cli/scripts/soak-daemon.ts` (fake-Linear fast soak validates the daemon end-to-end in 60s). Ops doc at `docs/phase-8/soak-test.md` lists required env + webhook config. User owns the staging Linear project + `LINEAR_API_KEY` + `LINEAR_WEBHOOK_SECRET` + cloudflared tunnel.
2. **Signed single-binary release** — `scripts/build-release.ts` compiles binaries; Claude sidecar bootstrap pins placeholder SHAs in `packages/adapters/claude/src/sidecar-pins.ts`. A release-automation pipeline locks a Claude CLI version, computes real SHA256s per platform, updates the pin file, and signs+notarizes the shamu binary. User owns the Apple Developer ID cert.

Post-Phase-8 follow-on tracks (not phase-blocking):

- **A2A ↔ supervisor integration.** Make a remote A2A agent a first-class swarm participant: route its artifacts through the mailbox, enforce G11 allow-list from run config, persist the trust store to SQLite, implement the outbound push-notification transport.
- **`brokerFactory` knob on `withEgressBroker`.** One-line swap from in-process to `@shamu/egress-broker-container` per run.
- **Adapter-runtime container attachment.** The second half of hard isolation for container-egress: the adapter subprocess joins the broker's Docker network with no default gateway, so subprocesses that ignore `HTTPS_PROXY` can't bypass.
- **TLS interception** for container-egress (per-run CA + subprocess trust-store + MITM rotation) — payload inspection.
- **`--unsafe-bind` real support** on the web dashboard — widened `ServerConfig.host` + auth layer.
- **`shamu doctor` cross-track enhancements** — audit-secret init flag, sidecar cache-state check.

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

1. `--unsafe-bind` is still documentation-only — real non-loopback support needs widened `ServerConfig.host` + auth + a follow-on escape-hatch UX.
2. Browser auto-launch is darwin + linux only; other platforms get a "please open manually" diag. Matches `shamu doctor`'s supported-platform set.
3. `startServer` returns `{ url, server, config, stop }`. Later callers may want `ready` signals (SSE subscriber count, hot-reload hooks); not needed for current scope.

### From PR #28 (egress-broker composition wiring)

1. OpenCode SDK `ServerOptions.env` — thread `opts.env` through once upstream grows the field. Today OpenCode accepts-and-ignores with a documented no-op.
2. Escalation-bus integration for `PolicyEgressDeniedEvent`. The routing wire is `withEgressBroker`'s `onEvent` → `createEscalationEmitter`; a direct helper lift would remove the manual wiring.
3. `mergeCallerEnv` helper duplicated across five adapters (Cursor/Gemini/Amp/Pi + Claude/Codex variants). Could DRY into `@shamu/adapters-base` if a future phase adds another adapter.

### From PR #30 (8.B A2A v1)

1. Supervisor + mailbox integration — remote A2A agent as a first-class swarm participant (listed in "What's next" above).
2. Outbound push-notification transport — `tasks/pushNotification/set` stores config but doesn't fire webhooks today.
3. SQLite-backed trust store for restart survival.
4. Card-fetcher test seam for spec-compatible TOFU (auto-populate unknown issuers from their `/.well-known/agent.json`).
5. One-phase demo path for deployments with known external URLs.

### From PR #31 (8.A autonomous loop)

1. **Real 24h Linear soak** — owed manual step (listed in "What's next").
2. `--egress-policy <path>` flag on `serve.ts` + `shamu.config.ts` schema addition for `egressPolicyPath` + per-adapter allowlist overrides.
3. Fast soak in nightly CI (60s fake soak on a dedicated workflow).
4. Drain banner as an appended section on the rolling comment (UX polish). Today it's a sibling comment per in-flight issue.
5. Hoist duplicated fake-Linear test helpers to `apps/cli/test/helpers/fake-linear.ts` (four files share the same ~150 LoC shape).
6. Harden boot: `withEgressBroker` start failure is currently log-warn + continue; make it fatal now that env is threaded end-to-end (#32 closed the no-op).

### From PR #32 (flow-runner env passthrough)

1. Subprocess CLI tests (`status`, `run`) implicitly share the workspace-scoped `.shamu/state/` DB; when an earlier run has populated rows, status-empty assertions flake. Force a tempdir via `$SHAMU_STATE_DIR` in each subprocess test's env.

### From PR #34 (8.C.1 doctor extensions)

1. `--init-audit-secret` flag (referenced in the audit-chain fail detail; deliberately out of scope this track).
2. Webhook health endpoint naming drift (`/health` vs `/webhooks/linear`). Accept both body shapes for now; align in a future track.

### From PR #35 (8.C.3 screenshot CI)

1. Visual-regression diffing (baselines in `apps/web/test/baselines/`, pixel-diff threshold).
2. TUI screenshots once the TUI lands.
3. Multi-viewport matrix (mobile/tablet/desktop).
4. Error-state + empty-state seed variants so reviewers see boundary renderings.

### From PR #36 (8.C.2 release + sidecar)

1. Release-automation pipeline locks a Claude CLI version, computes real SHA256s per platform, confirms the Anthropic release-URL convention, and regenerates `packages/adapters/claude/src/sidecar-pins.ts`. Tests validate shape only, so the swap is file-level.
2. `shamu doctor` sidecar cache-state check (cross-track wiring with the 8.C.1 surface).
3. `expectedSha` option on `ensureClaudeSidecar` is documented as "tests only". Promote to a first-class param if a runtime pin override is ever needed.

### From PR #37 (8.C.5 container egress)

1. `withEgressBroker` gains a `brokerFactory` knob so the in-process → container swap is a one-line config change (listed in "What's next").
2. Real Docker image build + publish pipeline (release track).
3. Adapter-runtime container attachment — the other half of hard isolation (listed in "What's next").
4. TLS interception / payload inspection.
5. `ContainerLogParseError` surfaced to operators via an `onParseError` seam on the broker emitter.
6. Multi-run single-broker + upstream-proxy chaining (inherited from the in-process broker's open items in #20).

### From PR #20 (egress broker — still open)

1. TLS interception for payload inspection (tracked under 8.C.5 follow-ons above).
2. Multi-run single-broker (per-connection policy tag via `Proxy-Authorization`).
3. Shared host-matcher factoring — move `policy.ts`'s decision function into `@shamu/policy` so a container enforcer imports the same code. Partially satisfied by the sync-comment inline in `packages/egress-broker-container/docker/proxy.ts`; a true shared module would eliminate the duplication.
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

### From Phase 6.C.3 (still open — some carried past Phase 8)

Closed by Phase 8.A (#31):
- Rate-limited concurrent pickups ✅
- Graceful drain-on-shutdown ✅
- Bounded-queue back-pressure for pickup driver ✅
- 24-hour soak test infrastructure ✅ (real run owed; see "What's next")

Still open:
- Auto-attach PR URL from flow output.
- CI-tripwire runId ↔ pickup runId mismatch.
- Persistent registry + rolling-comment state.
- Retry loop in escalation sink (honor `retryAfterSeconds`).

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
- **`apps/cli/.shamu-flow-shim/` accumulation** — closed by #31 (prune on boot + every 50th pickup).
- **Infrequent `agent-ci` flake** — ~1-in-3 failures observed locally; `check` job's container lacks `tsc`/`vitest` globally. Add a runner Dockerfile to stop the false red.
- **`macos-latest` CI flake** — the `run --dry-run` / `kill` subprocess tests in `apps/cli/test/commands.test.ts` time out at 5s under GitHub's shared macOS runners (`@shamu/cli#test` step). Ubuntu + all other jobs are reliable; macos-latest is NOT a branch-protection required check so PRs merge. Give the subprocess tests a macOS-only longer timeout (or move to `it.skipIf(process.platform === 'darwin')` if the flake is too noisy).

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
- `packages/egress-broker/` — in-process network policy proxy (default).
- `packages/egress-broker-container/` — Docker-backed peer with hard isolation (opt-in).
- `packages/core/composition/src/with-egress-broker.ts` — helper that spins up a per-run broker + merges proxy env onto SpawnOpts.
- `packages/protocol/a2a/` — Agent-to-Agent v1 server + client (Signed Agent Cards, JSON-RPC + SSE, bearer auth).
- `packages/linear/integration/src/rate-limiter.ts` — bounded semaphore + queue for the autonomous daemon.
- `apps/cli/src/commands/linear/serve.ts` — production daemon (two-phase drain, per-run broker, `.shamu-flow-shim/` prune).
- `apps/cli/scripts/soak-daemon.ts` + `docs/phase-8/soak-test.md` — fake-Linear fast soak + real 24h soak recipe.
- `apps/cli/src/commands/doctor.ts` + `apps/cli/src/services/doctor-*.ts` — environment health checks (audit chain, egress broker, NTP, webhook, tunnel).
- `scripts/build-release.ts` + `packages/adapters/claude/src/sidecar.ts` — single-binary release path + Claude sidecar auto-bootstrap.
- `scripts/capture-web-screenshots.ts` + `.github/workflows/screenshots.yml` — per-PR web dashboard screenshots.
- `apps/web/` — web dashboard MVP (Hono + SolidJS + SSE; 127.0.0.1-bound). `startServer()` exported for CLI embedding.
- `apps/cli/src/commands/ui.ts` — `shamu ui` CLI command (boots `@shamu/web` in-process, launches browser).
- `docs/architecture.md` / `docs/threat-model-summary.md` / `README.md` / `CONTRIBUTING.md` — project-level docs.
- `.claude/skills/shamu-dev/SKILL.md` — pipeline.
- `AGENTS.md` / `CLAUDE.md` — GitNexus-generated code context.

## HANDOFF maintenance

Update at phase boundaries (end of Phase N → flip status, refresh "next" section, rotate followups) and at mid-flight session ends (note in-flight agents + half-done files). Keep under ~200 lines. If it grows past that, leak content into PLAN.md.
