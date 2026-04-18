# Shamu — Session Handoff

**Last updated:** 2026-04-18 (Phase 7 kickoff: cleanup PR #11 landed; adapter-transport spike + PLAN.md rewrite in this PR. Next: spawn 7.A OpenCode + 7.B Cursor-ACP reference adapters.)

Any fresh session starts here. Load the `shamu-dev` skill (`.claude/skills/shamu-dev/SKILL.md`) to get the full pipeline; this file is the snapshot of *where we are right now*.

## TL;DR

Phase 6 is fully closed. Phase 7 kickoff is in flight. A Phase 6 cleanup pass (PR #11) absorbed five non-blocking carry-over followups (rolling-comment race, duplicate-nonce log spam, flow-module resolution shim, CLI logger unification, `parseRunId` helper). A Phase 7 transport spike classified the five remaining adapters (OpenCode / Cursor / Gemini / Amp / Pi) into four transport classes + one deferred fallback — writeup at `docs/phase-7/adapter-transports.md`. Key findings: Cursor and Gemini both speak ACP-stdio (JSON-RPC 2.0) — one ACP projector covers both; PLAN.md referenced a nonexistent `@google/gemini-cli-sdk` package (fixed); the obsolete "cloud REST + webhook" transport row for Cursor is retired. Kimi moved to Phase 7.X backlog.

- **Phase 6 cleanup** — PR **#11 → `dc9bcb4`**. Five followups. 68 CLI tests (+3 new files), 19 webhook server tests (+5), 8 ids tests (+3), ci-tripwire observer +1. `parseRunId` in `@shamu/shared/ids`; `Logger` is now a type alias for the shared class.
- **Phase 7 spike** — lives in this PR (`shamu/phase/7-kickoff`). Doc: `docs/phase-7/adapter-transports.md`. Four ratified decisions (Kimi deferral / Cursor distribution / ACP projector location / Amp long-lived / Gemini stdout-corruption) now in PLAN.md "Decisions captured from user".

18 workspace packages. 1101+ tests (exact count on next full run). Four gates green on cleanup PR.

## Read-first order for a fresh session

1. This file.
2. `git log --oneline | head -25` — shape of what's landed.
3. `PLAN.md` §§ "Core architecture", "Phased delivery → Phase 7" (rewritten 2026-04-18), "Decisions captured from user".
4. `docs/phase-7/adapter-transports.md` — per-adapter transport classification + evidence log.
5. Load `shamu-dev` skill for the pipeline mechanics.

## Where we are

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | De-risking spikes | ✅ all 5, writeups in `docs/phase-0/` |
| 1 | Foundations | ✅ all 5 tracks |
| 2 | Claude + Codex adapters | ✅ all 3 tracks |
| 3 | Supervisor, worktrees, mailbox, watchdog | ✅ 4/4 tracks |
| 4 | Plan → Execute → Review flow + composition | ✅ 4/4 tracks |
| 5 | agent-ci gate | ✅ 3/3 tracks; branch protection applied |
| 6 | Linear integration | ✅ 6.A (#3) / 6.B (#4) / 6.C (#6 + #7 + #8) / 6.D (#10) / cleanup (#11) |
| 7 | Adapter fan-out + web dashboard + egress broker | 🟡 kickoff in flight; reference-adapter order paved |
| 8 | Autonomous mode + A2A + ops polish | ⬜ |

## What's in flight

- **This PR (Phase 7 kickoff)** — PLAN.md rewrite + `docs/phase-7/adapter-transports.md`. Once merged, the reference adapters spawn next.

## Owed manual steps

None.

## Phase 7 next steps (after kickoff PR merges)

1. **Spawn 7.A (OpenCode — SSE-HTTP reference)** as the first reference adapter. Contract-test harness extraction happens here and becomes the template for 7.G capability matrix.
2. **Spawn 7.B (Cursor — ACP-stdio reference)** in parallel or immediately after 7.A lands. Includes the shared ACP projector at `packages/protocol/acp/`.
3. **Once 7.B is green**, fan out 7.C (Gemini — reuses ACP projector), 7.D (Amp — stream-JSON-shell variation), 7.E (Pi — custom-JSONL variation) in parallel with 7.H (web dashboard) and 7.I (egress broker).
4. **7.G (capability matrix, docs)** serializes after 7.A–7.E.

Phase 7.I (egress broker) is a G2 hard blocker for the Phase 8 autonomous daemon — it **must** land by end of Phase 7.

## Followups to absorb in Phase 7 / Phase 8 / later

### From Phase 6 cleanup PR #11 (new — 2026-04-18)

1. **`.shamu-flow-shim/` dir accumulation** — the CLI shim fallback (flow-contract.ts) copies one entry per distinct absolute path. A long-lived daemon fed many ephemeral paths would accumulate entries. Add prune or TTL (or switch to `os.tmpdir()` with time-based cleanup) as part of Phase 8.A daemon hardening.
2. **`escalation-sink.ts` still has an `as RunId` cast** on `EscalationRaised.childId` — candidate for a future sweep once the event's runtime shape is tightened to `RunId`.
3. **`duplicateNonceCount()` metric wiring** — read-only accessor on the webhook handler bundle; natural wire-up point for the Phase 8 metrics surface alongside `nonceCache.size()`.
4. **Infrequent agent-ci flake** — 1 of 3 runs during cleanup verification failed without surfacing a visible error. Probably a Docker container reap race; add a retry or investigate if it recurs.

### From Phase 6.D live E2E

Items 1–3 (rolling-comment race, duplicate-nonce spam, flow-module footgun) shipped in cleanup PR #11. No remaining 6.D followups.

### From Phase 6.C.3 (still open)

1. **Auto-attach PR URL from flow output** — the canonical flow doesn't surface a PR URL in its node outputs today. Hook: execute step pushes + runs `gh pr create` and includes the URL in `NodeOutput.value`; the runtime subscribes to `node_completed` and calls `attachPrToIssue`. Ship as part of Phase 8.A or as a separate "flow emits PR URL" followup. Today's `shamu linear attach-pr` is manual.
2. **CI-tripwire runId ↔ pickup runId mismatch** — the tripwire's `childId` is the newest runId in the streak, which may not match the current pickup's runId. The runtime's own failure-flip-to-blocked is a backstop, so user-visible behavior is correct, but the escalation sink's comment may not fire for tripwire events unless the registry has the tripwire's last runId. Revisit in Phase 8.A with a richer "supervisor bus event references a runId not directly bound to the pickup" lookup.
3. **Persistent registry + rolling-comment state** (Phase 8 daemon): add `run_issue_bindings` + `run_rolling_comments` tables to `@shamu/persistence` so daemon restarts don't orphan in-flight runs.
4. **Rate-limited concurrent pickups** (Phase 8.A): today's `onPickup` awaits serialize runs; Phase 8.A adds per-role + global concurrency caps.
5. **Graceful drain-on-shutdown** (Phase 8.A): today's SIGINT aborts the active flow via its AbortController; Phase 8.A drains running runs into a resumable state before exit.
6. **24-hour soak test** against a staging Linear project (Phase 8.A exit criterion).
7. **Retry loop in the escalation sink** honoring `LinearError.detail.retryAfterSeconds`.
8. **Bounded-queue back-pressure for the pickup driver** — today's sequential-await is correct but not a hard cap. If real-world slow consumers emerge, add drop-oldest via a bounded queue.

### From Phase 6.C.2 (still open)

9. **`AgentSessionEvent` subscription** — not in the current typed webhook union. Phase 7 may want agent-session routing once adapter fan-out lands.
10. **Live cloudflared smoke** — `tunnel.test.ts` mocks `spawnImpl`. A `SHAMU_LINEAR_LIVE=1` gate that spawns real cloudflared would exercise the full path.
11. **WebCrypto swap** in the webhook verifier — we use `node:crypto.timingSafeEqual`; not a concern while we're Bun-only.

### From Phase 6.A (still open)

12. **OAuth 2.1 DCR against `mcp.linear.app/mcp`** — revisit when shamu is hosted multi-tenant. Credential-store coordinates already exported so a future OAuth adapter can sibling the same account row.
13. **Rate-limit shape monitoring** — Linear's current shape is HTTP 400 with `extensions.code: RATELIMITED`. Callers that inspect `LinearError.detail.status` must not assume 429.

### Carried from Phase 5.A (still open)

14. **Artifact capture to SQLite** — `GateResult.runDir` exists; needs a `run_artifacts` table.
15. **Redactor pass on CI excerpts** — `@shamu/shared/redactor` not wired into `buildReviewerExcerpt`.
16. **Agent-ci programmatic abort** — swap SIGTERM for official `abort()` when `@redwoodjs/agent-ci` exposes one.
17. **Richer live gate smoke** — `gate.test.ts`'s `SHAMU_CI_LIVE=1` block is exit-code only.

### Carried from Phase 5.B (still open)

18. **`CINodeOutput` cast safety on rehydration** — revisit when flow-run resumability tests exercise CI output.
19. **Engine-side Loop body re-execution** (inherited from 4.A).
20. **Persistence `flow_run_id` ↔ CI run linkage** — observability correlation is a separate migration job.
21. **RFC upstream filing** — `docs/phase-5/rfc-report-json.md` draft. User owns whether to file on `@redwoodjs/agent-ci`.

### Carried from Phase 5.C (still open)

22. **`shellcheck` gate in CI** — not installed locally during 5.C; if `scripts/setup-branch-protection.sh` grows, add shellcheck on ubuntu-latest.
23. **Branch-protection script idempotency proof** — dry-run only verifies payload shapes.

### Carried from earlier phases (non-blocking)

24. **ParallelFanOut + Join node kinds** (4.A).
25. **Skipped-branch status propagation** (4.A).
26. **Richer `flow status` output** (4.C).
27. **Flow discovery** (4.C) — `shamu flow run <name>` without explicit module-spec.
28. **Progress streaming** (4.C).
29. **Paused exit code** (4.C) — taxonomy lacks `NEEDS_HUMAN`.
30. **TTL-refresh API on leases** (3.C).
31. **Recipient-list expansion in `mailbox.broadcast`** (3.C).
32. **Non-`main` base-branch discovery** (3.B).
33. **Subprocess auto-restart for the watchdog** (3.D).
34. **Phase 0 fixture regeneration** (2.x).
35. **Resume-through-expired-session E2E coverage** (2.x).
36. **`shamu cost <run-id>` subcommand** (2.x).
37. **Live subprocess real-spawn coverage in `adapters-base`** (2.x).

## Open questions for the user

None blocking.

## Already-answered decisions (don't re-litigate)

See PLAN.md "Decisions captured from user" for the canonical list. New in this phase:

- **Phase 7 adapter transport decisions (2026-04-18):** Kimi deferred to 7.X; Cursor default `vendorCliPath` = `~/.local/bin/agent` (require Cursor Desktop); ACP projector at `packages/protocol/acp/`; Amp long-lived subprocess; Gemini per-line validation for gemini-cli#22647. All five fully captured in PLAN.md.

Phase 6.C additions (still hold): composition root for the daemon in `apps/cli/src/services/linear-runtime.ts`; serialized pickups as the 6.C MVP; `runFlowInProcess` in `apps/cli/src/services/flow-runner.ts`; `EscalationCause` expansion; belt-and-suspenders failure flip; manual PR attachment for 6.D; daemon env contract; rolling-comment failure semantics; pickup driver cancellation cooperative; no bounded queue for pickups (sequential await = natural back-pressure).

Phase 6.A/6.B decisions (still hold): personal API key instead of OAuth DCR; `@shamu/shared/credentials` persist-back; async iterator on `handle.events`; 404 on non-`/webhooks/linear` paths; ±5-min timestamp tolerance; 10k-entry in-memory nonce cache.

Historical Phase 5 decisions still hold (DAG shape, verdict enum, FLOW_VERSION=2, CI node maxRetries=0, env allowlist, `GITHUB_REPO` resolution, CI tripwire parallel channel, branch-protection ruleset).

## Pointers

- `PLAN.md` — architecture + phased delivery + decisions + open questions (Phase 7 section rewritten 2026-04-18; transport decisions added)
- `docs/phase-7/adapter-transports.md` — per-adapter transport classification + evidence log (from kickoff spike)
- `.env` at repo root (gitignored) — holds `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, `LINEAR_WEBHOOK_SECRET` for local dev
- `packages/linear/*` — 6.A + 6.B + 6.C.2 packages
- `apps/cli/src/services/linear-runtime.ts` + `apps/cli/src/commands/linear/serve.ts` — 6.C.3 composition (with cleanup #11 race-fix)
- `.claude/skills/shamu-dev/SKILL.md` — the pipeline (load at session start)
- `AGENTS.md` / `CLAUDE.md` — GitNexus-generated code context
- `git log` — every phase has a detailed body

## HANDOFF maintenance

- Update at every phase boundary (end of Phase N → flip status, refresh "next" section, rotate followups).
- Update at any session end where work is mid-flight (note what agents are running, what files are half-done).
- Keep it short. If it grows past ~200 lines, something that should be in PLAN.md is leaking in.
