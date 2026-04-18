# Shamu — Session Handoff

**Last updated:** 2026-04-18 (Phase 5 closed out; both owed manual steps done; cleared for Phase 6 kickoff).

Any fresh session starts here. Load the `shamu-dev` skill (`.claude/skills/shamu-dev/SKILL.md`) to get the full pipeline; this file is the snapshot of *where we are right now*.

## TL;DR

Phase 5 (agent-ci gate) is ✅ at the unit+integration layer AND both previously-owed manual steps are green:

- Phase 4.B `SHAMU_FLOW_LIVE=1` smoke ran and passed (scripted-green `__ciRunOverride` landed in `cc71897` so the scratch tmp dir doesn't have to be a git repo for CI bootstrap).
- `scripts/setup-branch-protection.sh` applied against `watzon/shamu`. Verified: both rulesets `active`; classic protection on `main` has `required_status_checks=["CI / ubuntu-latest"]`, `required_signatures=true`, `required_linear_history=true`, `allow_force_pushes=false`, `required_approving_review_count=1`. SSH-key signing configured locally (`gpg.format=ssh`, `commit.gpgsign=true`) so subsequent commits meet the signed-commits rule.
- `origin` remote set to `git@github.com:watzon/shamu.git` and all 38 commits pushed to `main` (initial push).

`@shamu/ci` lifts the Phase 0.D spike into production; the canonical flow gates approval on green CI as a structural property (new `ci` DAG node, verdict schema extended with `requires_ci_rerun`, reviewer auto-overrides approve-on-red); the watchdog has a per-role CI-failure tripwire. Phase 6 (Linear integration) is next and unblocked. Nothing in flight. 15 workspace packages, 864 tests (+86 since end of Phase 4).

## Read-first order for a fresh session

1. This file.
2. `git log --oneline | head -25` — shape of what's landed.
3. `PLAN.md` §§ "Core architecture", "Phased delivery → Phase 6".
4. Load `shamu-dev` skill for the pipeline mechanics.

## Where we are

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | De-risking spikes | ✅ all 5, writeups in `docs/phase-0/` |
| 1 | Foundations | ✅ all 5 tracks |
| 2 | Claude + Codex adapters | ✅ all 3 tracks |
| 3 | Supervisor, worktrees, mailbox, watchdog | ✅ 4/4 tracks |
| 4 | Plan → Execute → Review flow + composition | ✅ 4/4 tracks; live smoke ran green (`cc71897` override) |
| 5 | agent-ci gate | ✅ 3/3 tracks (5.A/5.B/5.C); branch protection applied on `watzon/shamu`; CI-tripwire wiring still owed as Phase 6 followup #9 |
| 6 | Linear integration | ⬜ next (cleared to start) |
| 7 | Adapter fan-out + web dashboard + egress broker | ⬜ |
| 8 | Autonomous mode + A2A + ops polish | ⬜ |

## Workspace packages (end of Phase 5)

15 packages. Phase 5 adds **`@shamu/ci`**; Phase 5.B modifies `@shamu/flows-plan-execute-review`; Phase 5.C extends `@shamu/watchdog`.

- `@shamu/shared` — events/IDs/Result/logger/credentials/redactor/errors/capabilities
- `@shamu/persistence` — SQLite schema, migrations (v1 + v2 `flow_runs`), HMAC-chained audit, prepared-statement queries
- `@shamu/adapters-base` — contract, subprocess + Node-drain + JSONL, path-scope, shell AST gate, replay, contract suite, T17 cost-stamping helper
- `@shamu/adapter-echo` — in-memory reference adapter (13/13 contract)
- `@shamu/adapter-claude` — production adapter on `@anthropic-ai/claude-agent-sdk@0.2.113` (13/13 contract, T9 cache-key pinned, in-process MCP)
- `@shamu/adapter-codex` — production adapter on `@openai/codex-sdk@0.121.0` (13/13 contract, snapshot pinned, API-key + ChatGPT-OAuth paths)
- `@shamu/cli` — `shamu run` / `shamu resume` / `shamu flow run` / `shamu flow status`, NDJSON telemetry, flow-module loader (Phase 4.C)
- `@shamu/core-supervisor` — OTP-shaped Supervisor/Swarm/EventBus + intensity tracker + `EscalationRaised` bus (Phase 3.A)
- `@shamu/worktree` — per-run git worktree lifecycle + GC + per-worktree `pre-commit` hook via `core.hooksPath` (Phase 3.B + 4.D test)
- `@shamu/mailbox` — trusted mailbox + lease primitives (G6 `from_agent` auth, stale-lease reclaim, materialized JSONL export) (Phase 3.C)
- `@shamu/watchdog` — out-of-process Bun subprocess, four confidence-labeled signals, two-observation agreement rule, **per-role CI-failure tripwire (Phase 5.C)**
- `@shamu/core-flow` — typed, serializable, resumable DAG workflow engine with content-hash dedupe and cost roll-up (Phase 4.A)
- `@shamu/flows-plan-execute-review` — canonical plan → execute → **ci** → review flow (Phase 5.B); reviewer sees CI summary + excerpt; verdict enum `{approve, revise, requires_ci_rerun}`; red-CI forces auto-revise; `FLOW_VERSION: 2`
- `@shamu/core-composition` — cross-primitive glue: EscalationEmitter shim + persistenceReadRun driver + diffOverlapCheck helper (Phase 4.D)
- **`@shamu/ci`** — `@redwoodjs/agent-ci` wrapper: Bun.spawn driver, run-dir discovery via pre/post diff, parse-run-state/parse-step-log extractors (TAP-13 + ESLint-stylish + tail), ANSI strip, deterministic reviewer excerpt, `CIRed` / `PatchReady` domain-event projection, 3 Phase 0.D fixtures as byte-identical replay snapshots (Phase 5.A)

864 tests across 15 packages (+86 over end-of-Phase-4): `@shamu/ci` 76 passing + 1 live-skipped, `@shamu/flows-plan-execute-review` 50 passed + 1 skipped (was 35+1), `@shamu/watchdog` 75 passed (includes 11 new ci-tripwire tests).

## What's in flight

Nothing. Phase 5 fully committed (commits `bfee0c3`, `53b66c8`, `1318f06`, `f59e6eb`, plus the post-close Phase 5 followup `cc71897` smoke-override and two gitnexus banner refreshes).

## Owed manual steps

None. Both prior owed steps are green:

1. ~~Phase 4.B `SHAMU_FLOW_LIVE=1` smoke~~ — ran and passed after `cc71897` added a scripted-green `__ciRunOverride` so the scratch tmp dir doesn't need to be a git repo for agent-ci bootstrap. The "richer live gate smoke" (Phase 5.A followup #4) against real workflows is still a separate, lower-priority future exercise.
2. ~~`scripts/setup-branch-protection.sh`~~ — applied against `watzon/shamu`. `origin` remote set to `git@github.com:watzon/shamu.git`; initial push of 38 commits landed; SSH-key signing configured locally so future commits to `main`/`shamu/integration/*` meet the `required_signatures` rule.

## Phase 6 plan (from PLAN.md)

**Tracks:**
- **6.A Auth + client (Serial)** — OAuth 2.1 DCR against `mcp.linear.app/mcp`; token persistence via `@shamu/shared/credentials` (Keychain on macOS, libsecret on Linux); typed MCP client wrapper for the issue/comment/status tools actually used.
- **6.B Webhook receiver (Parallel with 6.A)** — `packages/linear/webhook`: Bun HTTP server + HMAC signature verification + timestamp-window + nonce-cache replay protection. `shamu linear tunnel` wraps cloudflared scoped to `/webhooks/linear` only (G10). Subscribe to `issue-label-added`, `comment-created`, `status-changed`.
- **6.C Work-intake conventions (Serial after 6.A + 6.B)** — Labels `shamu:ready` / `shamu:in-progress` / `shamu:review` / `shamu:blocked`. Rolling-comment updater (one comment per run, edited in place with checkpoint appends). PR link as Linear attachment on completion. Escalation path: watchdog-trip (including **new `watchdog.ci_tripwire` events from 5.C**) flips status to `shamu:blocked` + incident-summary comment.
- **6.D Integration test (Serial after 6.C)** — E2E against a throwaway Linear workspace: label → pickup → PR → status flip.

**Exit:** a Linear issue with `shamu:ready` gets picked up, worked, and ends with a PR link + status flip, entirely webhook-driven.

Natural hook points Phase 5 leaves ready for Phase 6:
- `@shamu/ci.toDomainEvent` already emits `CIRed` / `PatchReady` — Phase 6's Linear sink subscribes to the same bus the `EscalationEmitter` feeds, so no new event taxonomy is needed.
- Phase 5.C's `WatchdogCiTripwire` event is already structurally compatible with the supervisor bus; wiring it through is 6.C's escalation-path plumbing combined with the Phase 5.C followup (#1 below).

## Followups to absorb in Phase 6 (or later)

### From Phase 5.A

1. **Artifact capture to SQLite** — PLAN bullet left unticked. `GateResult.runDir` exists; a persistence surface is needed (either a new `run_artifacts` table or reuse of a `run-metadata` column once one lands). Schema migration was scoped out of 5.A.
2. **Redactor pass on CI excerpts** — `@shamu/shared/redactor` exists but isn't wired into `buildReviewerExcerpt`. Step logs may contain planted secrets. Seam is `parseRunState`'s `summarizeJob` boundary; requires threading a `Redactor` through `readStepLog`. Skipped to keep 5.A byte-identical to the spike snapshots.
3. **Agent-ci programmatic abort** — `@shamu/ci/gate.ts` interrupt path SIGTERMs the child; `@redwoodjs/agent-ci@0.10.7` does not expose a programmatic `abort()`. If a future release adds one, swap the SIGTERM for the official call.
4. **Richer live gate smoke** — `gate.test.ts`'s `SHAMU_CI_LIVE=1` block is an exit-code check only. Extend once a human is watching it.

### From Phase 5.B

5. **`CINodeOutput` cast safety on rehydration** — `extractPriorCiOutput` carries `CIRunSummary` via a cast past `.passthrough()`. If persistence ever serializes + rehydrates `NodeOutput.value`, the cast becomes unsafe. Revisit when flow-run resumability tests exercise CI output.
6. **Engine-side Loop body re-execution** — carried from Phase 4.A. Once the engine re-invokes body nodes per iteration, collapse the reviewer-internal revise loop; `loopNode.body=[execute, ci, review]` is already self-describing and ready. The reviewer's `iterationCounters` Map becomes dead code.
7. **Persistence `flow_run_id` ↔ CI run linkage** — the `ci` runner emits `CINodeOutput` but doesn't thread `flowRunId` into CI's `runId` namespace. Observability correlation is a separate migration job (similar to followup #12 from Phase 4.C).
8. **RFC upstream filing** — `docs/phase-5/rfc-report-json.md` is a draft. User owns whether to file on `@redwoodjs/agent-ci`.

### From Phase 5.C

9. **CI-tripwire caller wiring (blocking for live use).** `@shamu/watchdog/ci-tripwire` is the mechanism; nothing calls `observe()` yet. `@shamu/core-composition` is the natural home — match the EscalationEmitter shim pattern. It needs to: (a) instantiate `createCiTripwire({ emitter })` per flow-run (or per-process with `reset()` on flow boundaries), (b) subscribe to CI domain events (`CIRed` / `PatchReady` from `@shamu/ci` or `CINodeOutput.summary.status` from the flow), (c) forward `emitCiTripwire` → supervisor bus (parallel to the existing `WatchdogAlert` → `EscalationRaised` wiring). Best landed at the start of Phase 6 since the Linear sink consumes the same event bus.
10. **`shellcheck` gate in CI** — not installed locally during 5.C; if `scripts/setup-branch-protection.sh` grows, add shellcheck as a workflow step on ubuntu-latest.
11. **Branch-protection script idempotency proof** — dry-run only verifies payload shapes; a future exercise re-runs against a sandbox repo to confirm PUT-over-existing-ruleset semantics in practice.

### Carried from earlier phases (still non-blocking)

12. **ParallelFanOut + Join node kinds** (4.A) — flow engine is sequential-only.
13. **Per-iteration Loop body execution** (4.A) — see #6; same root cause.
14. **Skipped-branch status propagation** (4.A) — conditional-skipped nodes remain `pending`.
15. **Richer `flow status` output** (4.C) — per-node cost breakdown + event replay.
16. **Flow discovery** (4.C) — `shamu flow run <name>` without explicit module-spec (registry/config file).
17. **Progress streaming** (4.C) — intra-node progress surfaced via the NDJSON sink.
18. **Paused exit code** (4.C) — taxonomy lacks a `NEEDS_HUMAN` code.
19. **Extend `EscalationCause`** (4.D) — add `"watchdog_agreement"` + `"lease_reclaim_refused"` + (new for Phase 5.C) `"ci_tripwire"` variants so sinks can switch on shape rather than parse `reason`.
20. **TTL-refresh API on leases** (3.C) — `renewLease` for long-running executors.
21. **Recipient-list expansion in `mailbox.broadcast`** (3.C) — requires a "who's in this swarm now?" helper.
22. **Non-`main` base-branch discovery** (3.B) — `worktree.createWorktree` trusts the caller's `baseBranch`; a helper for `origin/HEAD` removes the hardcoding.
23. **Subprocess auto-restart for the watchdog** (3.D) — `spawnWatchdogSubprocess` has no liveness poll.
24. **Phase 0 fixture regeneration** (2.x) — capture scripts predate production adapters; rewrite once a live auth path is available.
25. **Resume-through-expired-session E2E coverage** (2.x).
26. **`shamu cost <run-id>` subcommand** (2.x) — `emitRunCostSummary` ready to reuse.
27. **Live subprocess real-spawn coverage in `adapters-base`** (2.x) — `SHAMU_CLAUDE_LIVE=1` closes the gap.

## Open questions for the user

None blocking. (PLAN's "Remaining open questions" empty since 2026-04-18 A2A decision.)

## Already-answered decisions (don't re-litigate)

See prior HANDOFF entries; nothing re-litigated in Phase 5. Phase 5 additions:

- **DAG shape** — `plan → execute → ci → review → loop`. CI is its own node; reviewer reads `ctx.priorOutputs.ci`; reviewer's internal re-execute loop also re-runs CI so every iteration sees a fresh result.
- **Verdict enum** — `{approve, revise, requires_ci_rerun}`. Red-CI + approve → reviewer runner auto-rewrites to revise with a synthetic feedback prefix + synthetic concern.
- **`FLOW_VERSION: 2`** — bumped from 1; persistence keys resumability on it.
- **CI node `maxRetries: 0`** — agent-ci has its own workflow-level retry; boot failures aren't retriable at the DAG layer. Flip the constant if live use disagrees.
- **Excerpt contract is `string` (not structured)** — keeps the fixture snapshots and the domain-event projection byte-identical-comparable.
- **Env allowlist for agent-ci subprocess** — `PATH`, `HOME`, `LANG`, `USER`, `GITHUB_REPO`, plus caller-forwarded entries. No blanket `process.env`.
- **`GITHUB_REPO` resolution order** — caller's `env.GITHUB_REPO` > caller's `opts.githubRepo` > `git remote get-url origin` parsed (GitHub-only; non-GitHub remotes are user error).
- **CI tripwire is parallel to the agreement buffer, not inside it** — same-signal, cross-run, per-role counter is a different temporal shape than the two-signal agreement rule. Lives in `@shamu/watchdog/ci-tripwire.ts` with its own event kind.
- **`emitCiTripwire` is OPTIONAL on `WatchdogEmitter`** — emitter falls back to `emit`; existing emitters don't need a coordination commit.
- **Branch protection is user-applied, not code-driven** — `scripts/setup-branch-protection.sh` is the delivery vehicle.
- **CI workflow actions SHA-pinned** — `actions/checkout@v4 → 34e11487...`, `oven-sh/setup-bun@v2 → 0c5077e5...`, `actions/upload-artifact@v4 → ea165f8d...`. Tag comments next to each SHA.
- **Required status check name `CI / ubuntu-latest`** — load-bearing for `scripts/setup-branch-protection.sh`. Renaming the matrix job breaks the gate.

## Pointers

- `PLAN.md` — architecture + phased delivery + decisions + open questions
- `PLAN_REVIEW.md` — adversarial review (historical; shows why choices stand)
- `docs/phase-0/*.md` — spike writeups, go/no-go findings, evidence
- `docs/phase-5/rfc-report-json.md` — upstream RFC draft for `@redwoodjs/agent-ci --report=json` (Phase 5.B)
- `scripts/setup-branch-protection.sh` + `scripts/README.md` — branch-protection apply (Phase 5.C)
- `.github/workflows/ci.yml` — required status check (name load-bearing)
- `.claude/skills/shamu-dev/SKILL.md` — the pipeline (load at session start)
- `AGENTS.md` / `CLAUDE.md` — GitNexus-generated code context
- `git log` — every phase has a detailed body

## HANDOFF maintenance

- Update at every phase boundary (end of Phase N → flip status, refresh "next" section, rotate followups).
- Update at any session end where work is mid-flight (note what agents are running, what files are half-done).
- Keep it short. If it grows past ~200 lines, something that should be in PLAN.md is leaking in.
