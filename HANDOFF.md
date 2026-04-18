# Shamu — Session Handoff

**Last updated:** 2026-04-18 (Phase 6.C complete: 6.C.1 + 6.C.2 + 6.C.3 landed via PRs #6–#8; 6.D next).

Any fresh session starts here. Load the `shamu-dev` skill (`.claude/skills/shamu-dev/SKILL.md`) to get the full pipeline; this file is the snapshot of *where we are right now*.

## TL;DR

Phase 6.C is fully landed. A new package (`@shamu/linear-integration`) + a new CLI command group (`shamu linear serve`, `shamu linear attach-pr`) ship the full label-state machine, rolling-comment updater, PR-attachment helper, webhook pickup driver, and escalation sink. The daemon picks up `shamu:ready` Linear issues, runs the canonical plan-execute-review flow in-process, drives a rolling comment from the flow's events, and flips labels on completion or escalation. Auto-PR-attach from the flow is a deferred followup (canonical flow doesn't emit a PR URL yet); 6.D uses `shamu linear attach-pr` manually.

- **Phase 6.C.1** (CI tripwire wiring) — PR **#6 → `7292500`**. `createCiTripwireObserver` in `@shamu/core-composition` bridges flow bus → watchdog tripwire; `createEscalationEmitter`'s `watchdogEmitter` now implements `emitCiTripwire` → `EscalationRaised` with `cause: "ci_tripwire"`. `EscalationCause` union extended with three typed variants so downstream sinks can switch on shape.
- **Phase 6.C.2** (primitives) — PR **#7 → `2923602`**. New `@shamu/linear-integration` package: `createLabelStateMachine` / `createRollingComment` / `attachPrToIssue` / `createRunIssueRegistry` / `createPickupDriver` / `createEscalationSink` + scope-exception `LinearClient.createAttachment`.
- **Phase 6.C.3** (daemon) — PR **#8 → `da03c87`**. `shamu linear serve` CLI + `shamu linear attach-pr` CLI; `runFlowInProcess` extraction; `createLinearRuntime` composition root in `apps/cli/src/services/linear-runtime.ts`.

18 workspace packages (17 before 6.C.2 + `@shamu/linear-integration`). 1090 tests across 18 packages (CLI 46 → 65, linear-integration 0 → 45, linear-client 57 → 61, composition 28 → 42 — plus the small pre-6.C fixtures). Four gates green on every PR.

## Read-first order for a fresh session

1. This file.
2. `git log --oneline | head -25` — shape of what's landed.
3. `PLAN.md` §§ "Core architecture", "Phased delivery → Phase 6" (Track 6.D is next).
4. Load `shamu-dev` skill for the pipeline mechanics.

## Where we are

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | De-risking spikes | ✅ all 5, writeups in `docs/phase-0/` |
| 1 | Foundations | ✅ all 5 tracks |
| 2 | Claude + Codex adapters | ✅ all 3 tracks |
| 3 | Supervisor, worktrees, mailbox, watchdog | ✅ 4/4 tracks |
| 4 | Plan → Execute → Review flow + composition | ✅ 4/4 tracks |
| 5 | agent-ci gate | ✅ 3/3 tracks; branch protection applied |
| 6 | Linear integration | **6.A ✅ (#3) / 6.B ✅ (#4) / 6.C ✅ (#6 + #7 + #8) / 6.D ⬜** |
| 7 | Adapter fan-out + web dashboard + egress broker | ⬜ |
| 8 | Autonomous mode + A2A + ops polish | ⬜ |

## Workspace packages (18 total)

- `@shamu/shared` — events/IDs/Result/logger/credentials/redactor/errors/capabilities
- `@shamu/persistence` — SQLite schema, migrations, HMAC-chained audit, prepared-statement queries
- `@shamu/adapters-base`, `@shamu/adapter-echo`, `@shamu/adapter-claude`, `@shamu/adapter-codex` — adapter contract + production adapters
- `@shamu/cli` (under `apps/cli/`) — shamu command. Phase 6.C.3 adds `shamu linear serve` (daemon) + `shamu linear attach-pr` (manual PR attachment) + extracted `runFlowInProcess` service + `createLinearRuntime` composition root.
- `@shamu/core-supervisor`, `@shamu/worktree`, `@shamu/mailbox`, `@shamu/watchdog` — Phase 3 primitives. 6.C.1 extends `EscalationCause` with `"watchdog_agreement" | "lease_reclaim_refused" | "ci_tripwire"`.
- `@shamu/core-flow`, `@shamu/flows-plan-execute-review`, `@shamu/core-composition` — Phase 4 flow engine + canonical plan → execute → ci → review flow. 6.C.1 adds `createCiTripwireObserver` + `emitCiTripwire` to `createEscalationEmitter`.
- `@shamu/ci` — Phase 5 agent-ci wrapper + CI domain events
- `@shamu/linear-client` — personal-API-key resolver + typed GraphQL client. 6.C.2 adds `createAttachment` mutation.
- `@shamu/linear-webhook` — HMAC-verifying webhook receiver + async-iterable event sink + cloudflared tunnel wrapper
- **`@shamu/linear-integration` (Phase 6.C.2)** — orchestration primitives: `createLabelStateMachine`, `createRollingComment`, `attachPrToIssue`, `createRunIssueRegistry`, `createPickupDriver`, `createEscalationSink`, plus `SHAMU_LABELS` + `DEFAULT_ESCALATION_TEMPLATES` (all six `EscalationCause` variants).

## What's in flight

Nothing. 6.C fully merged. 6.D not started.

## Owed manual steps

None.

## Phase 6 remaining (from PLAN.md)

**Track 6.D — Integration test (Serial after 6.C):**
- E2E against a throwaway Linear workspace: label → pickup → PR → status flip.
- Workflow: provision a test issue in a real Linear workspace; attach `shamu:ready`; start `shamu linear serve` locally + `shamu linear tunnel` for public ingress; watch for pickup → in-progress → review (or blocked). Use `shamu linear attach-pr` manually to simulate PR-opened completion since auto-attach-from-flow is a followup.
- LINEAR_API_KEY + LINEAR_TEAM_ID + LINEAR_WEBHOOK_SECRET live in `.env` at repo root (gitignored).

**Exit:** a Linear issue with `shamu:ready` gets picked up, worked, and ends with a PR link + status flip, entirely webhook-driven.

## Followups to absorb in 6.D / Phase 8 / later

### From Phase 6.C.3 (new)

1. **Auto-attach PR URL from flow output** — the canonical flow doesn't surface a PR URL in its node outputs today. The hook would be: execute step pushes + runs `gh pr create` and includes the URL in its `NodeOutput.value`; the runtime subscribes to `node_completed` and calls `attachPrToIssue`. Ship as part of Phase 8.A or as a separate "flow emits PR URL" followup. 6.D uses `shamu linear attach-pr` manually.
2. **CI-tripwire runId ↔ pickup runId mismatch** — the tripwire's `childId` is the newest runId in the streak, which may not match the current pickup's runId. The runtime's own failure-flip-to-blocked is a backstop so user-visible behavior is correct, but the escalation sink's comment may not fire for tripwire events unless the registry has the tripwire's last runId. Revisit in Phase 8.A with a richer "supervisor bus event references a runId not directly bound to the pickup" lookup.
3. **Unify CLI stub logger with `@shamu/shared/logger.Logger`** — two Logger shapes coexist because the runtime wants the real class while `withServices` still builds a stub. Small refactor; non-blocking.
4. **Persistent registry + rolling-comment state** (Phase 8 daemon): add `run_issue_bindings` + `run_rolling_comments` tables to `@shamu/persistence` so daemon restarts don't orphan in-flight runs.
5. **Rate-limited concurrent pickups** (Phase 8.A): today's `onPickup` awaits serialize runs; Phase 8.A adds per-role + global concurrency caps.
6. **Graceful drain-on-shutdown** (Phase 8.A): today's SIGINT aborts the active flow via its AbortController; Phase 8.A drains running runs into a resumable state before exit.
7. **24-hour soak test** against a staging Linear project (Phase 8.A exit criterion).
8. **Retry loop in the escalation sink** honoring `LinearError.detail.retryAfterSeconds`.
9. **Bounded-queue back-pressure for the pickup driver** (HANDOFF #4 from 6.C.2) — today's sequential-await is correct but not a hard cap. If real-world slow consumers emerge, add drop-oldest via a bounded queue.

### From Phase 6.C.2 (still open)

10. **`AgentSessionEvent` subscription** — not in the current typed webhook union. Phase 7 may want agent-session routing once adapter fan-out lands.
11. **Live cloudflared smoke** — `tunnel.test.ts` mocks `spawnImpl`. A `SHAMU_LINEAR_LIVE=1` gate that spawns real cloudflared would exercise the full path.
12. **WebCrypto swap** in the webhook verifier — we use `node:crypto.timingSafeEqual`; not a concern while we're Bun-only.

### From Phase 6.C.1 (still open)

13. **`RunId` branded-type discipline** — a proper `parseRunId` in `@shamu/shared/ids` would cleaner than the `as RunId` casts in `ci-tripwire-observer` + `linear-runtime`. Phase 5.B followup #13 tracks this.

### From Phase 6.A (still open)

14. **OAuth 2.1 DCR against `mcp.linear.app/mcp`** — revisit when shamu is hosted multi-tenant. Credential-store coordinates already exported so a future OAuth adapter can sibling the same account row.
15. **Rate-limit shape monitoring** — Linear's current shape is HTTP 400 with `extensions.code: RATELIMITED`. Callers that inspect `LinearError.detail.status` must not assume 429.

### Carried from Phase 5.A (still open)

16. **Artifact capture to SQLite** — `GateResult.runDir` exists; needs a `run_artifacts` table.
17. **Redactor pass on CI excerpts** — `@shamu/shared/redactor` not wired into `buildReviewerExcerpt`.
18. **Agent-ci programmatic abort** — swap SIGTERM for official `abort()` when `@redwoodjs/agent-ci` exposes one.
19. **Richer live gate smoke** — `gate.test.ts`'s `SHAMU_CI_LIVE=1` block is exit-code only.

### Carried from Phase 5.B (still open)

20. **`CINodeOutput` cast safety on rehydration** — revisit when flow-run resumability tests exercise CI output.
21. **Engine-side Loop body re-execution** (inherited from 4.A).
22. **Persistence `flow_run_id` ↔ CI run linkage** — observability correlation is a separate migration job.
23. **RFC upstream filing** — `docs/phase-5/rfc-report-json.md` draft. User owns whether to file on `@redwoodjs/agent-ci`.

### Carried from Phase 5.C (still open)

24. **`shellcheck` gate in CI** — not installed locally during 5.C; if `scripts/setup-branch-protection.sh` grows, add shellcheck on ubuntu-latest.
25. **Branch-protection script idempotency proof** — dry-run only verifies payload shapes.

### Carried from earlier phases (non-blocking)

26. **ParallelFanOut + Join node kinds** (4.A).
27. **Skipped-branch status propagation** (4.A).
28. **Richer `flow status` output** (4.C).
29. **Flow discovery** (4.C) — `shamu flow run <name>` without explicit module-spec.
30. **Progress streaming** (4.C).
31. **Paused exit code** (4.C) — taxonomy lacks `NEEDS_HUMAN`.
32. **TTL-refresh API on leases** (3.C).
33. **Recipient-list expansion in `mailbox.broadcast`** (3.C).
34. **Non-`main` base-branch discovery** (3.B).
35. **Subprocess auto-restart for the watchdog** (3.D).
36. **Phase 0 fixture regeneration** (2.x).
37. **Resume-through-expired-session E2E coverage** (2.x).
38. **`shamu cost <run-id>` subcommand** (2.x).
39. **Live subprocess real-spawn coverage in `adapters-base`** (2.x).

## Open questions for the user

None blocking.

## Already-answered decisions (don't re-litigate)

Phase 6.C additions:

- **Composition root for the daemon** — lives in `apps/cli/src/services/linear-runtime.ts`, not in `@shamu/linear-integration`. The integration package stays primitive-only; wiring into a running shamu instance is the CLI's job (it's already the composition root with deps on core-flow + flows + persistence).
- **Serialized pickups** — `PickupDriverHandle.onPickup` is awaited, so runs execute one-at-a-time. This is the designed 6.C MVP; Phase 8.A adds concurrency + rate limiting.
- **`runFlowInProcess` extraction** — moved into `apps/cli/src/services/flow-runner.ts`; `shamu flow run` delegates to it. The command handler still owns SIGINT/SIGTERM, DB lifecycle, bus creation, exit-code mapping — the service is lifecycle-agnostic.
- **`EscalationCause` expansion** — the supervisor's cause union is now `"intensity_exceeded" | "start_failed" | "policy_violation" | "watchdog_agreement" | "lease_reclaim_refused" | "ci_tripwire"`. The composition emitter no longer emits `"policy_violation"` (reserved catch-all for hand-authored callers layered above the supervisor).
- **Belt-and-suspenders failure flip** — both the escalation sink and the runtime's failure path flip to `shamu:blocked`. Label machine is idempotent so double-flip is harmless.
- **Manual PR attachment for 6.D** — `shamu linear attach-pr` is a standalone CLI. Auto-attach-from-flow requires the canonical flow to emit a PR URL in a node output, which today it doesn't. Deferred as followup #1 above.
- **Daemon env contract** — `shamu linear serve` reads `LINEAR_API_KEY` via `resolveLinearApiKey` (env-first, credential-store persist-back), plus `LINEAR_TEAM_ID` (required), `LINEAR_WEBHOOK_SECRET` (required), `LINEAR_WEBHOOK_PORT` / `_HOST` (optional), `SHAMU_LINEAR_API_URL` (test-seam + self-host seam).
- **Rolling-comment failure semantics** — in-memory body state commits only on successful `updateComment` so a transient Linear error doesn't desync memory from Linear. `finalize` is idempotent (second call no-ops).
- **Pickup driver cancellation** — cooperative `iterator.return()`; the webhook sink implements it. No AbortController needed.
- **No bounded queue for pickups** — sequential `await` back-pressures the webhook producer naturally; Linear's webhook retries handle drops. Followup #9 adds drop-oldest if needed.

Phase 6.A/6.B decisions (still hold):

- 6.A: personal API key instead of OAuth 2.1 DCR; `https://api.linear.app/graphql`; `@shamu/shared/credentials` persist-back; rate-limit handling normalizes both 429+Retry-After and 400+RATELIMITED shapes.
- 6.B: async iterator on `handle.events`; 404 on non-`/webhooks/linear` paths; ±5-min timestamp tolerance; in-memory nonce cache (10k entries, 10-min window).

Historical Phase 5 decisions still hold (DAG shape, verdict enum, FLOW_VERSION=2, CI node maxRetries=0, env allowlist, `GITHUB_REPO` resolution, CI tripwire parallel channel, branch-protection ruleset).

## Pointers

- `PLAN.md` — architecture + phased delivery + decisions + open questions (Phase 6 Track 6.C bullets now ticked with the 6.C.3 composition note)
- `.env` at repo root (gitignored) — holds `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, `LINEAR_WEBHOOK_SECRET` for local dev
- `packages/linear/client/` + `packages/linear/webhook/` + `packages/linear/integration/` — 6.A + 6.B + 6.C.2 packages
- `apps/cli/src/services/linear-runtime.ts` + `apps/cli/src/commands/linear/serve.ts` — 6.C.3 composition
- `packages/core/composition/src/ci-tripwire-observer.ts` + `escalation-emitter.ts` — 6.C.1 bridge
- `.claude/skills/shamu-dev/SKILL.md` — the pipeline (load at session start)
- `AGENTS.md` / `CLAUDE.md` — GitNexus-generated code context
- `git log` — every phase has a detailed body

## HANDOFF maintenance

- Update at every phase boundary (end of Phase N → flip status, refresh "next" section, rotate followups).
- Update at any session end where work is mid-flight (note what agents are running, what files are half-done).
- Keep it short. If it grows past ~200 lines, something that should be in PLAN.md is leaking in.
