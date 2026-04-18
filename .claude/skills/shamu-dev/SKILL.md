---
name: shamu-dev
description: Use at the start of any shamu development session, when continuing work on the multi-agent orchestrator, when advancing through phases, spawning sub-agent swarms, or deciding what to do next. Cements the development pipeline (HANDOFF → PLAN → swarm → verify → commit) and the invariants that survive across sessions.
license: MIT
---

# Shamu — Development Pipeline

Shamu is a multi-agent coding-orchestrator being built **by a swarm of coding agents**. That recursion is the product; it's also the process. This skill is the contract for how that process runs across sessions.

## First 3 minutes of any session

Do these in order, no agent-spawning until they're done:

1. **Read `HANDOFF.md`** at the repo root — current state, what's next, what's in flight, user-owed answers.
2. **`git log --oneline | head -25`** — shape of what's landed; every phase commit has a rich body.
3. **Read `PLAN.md`** §§ "Core architecture" + "Phased delivery → Phase N" (where N = current phase from HANDOFF).
4. **Scan the followups list** in HANDOFF for the current phase — those MUST be absorbed.

Then (and only then) begin planning the current phase.

## The phase pipeline

Each phase in PLAN.md has Tracks A, B, C… labeled **Parallel** or **Serial**. One cycle per phase:

### Intake
- Confirm prerequisite phases are ✅ (PLAN checkboxes + HANDOFF agree).
- Identify Parallel vs Serial tracks for this phase.
- Review carry-over followups from prior phases.
- Announce to the user: here's what's landing, here's what I'm spawning.

### Plan the swarm
- For each unblocked Parallel track, draft a sub-agent prompt (template below).
- For Serial tracks, plan sequential execution with explicit dependencies.
- Use `TaskCreate` for in-session tracking (session-scoped; dies at session end — don't rely on it for persistence).

### Spawn
- Fire agents with `run_in_background: true` in a **single message** containing parallel tool calls — this is what makes the swarm a swarm.
- Each agent is scoped to non-overlapping paths. Sibling tracks do not share files.
- Agents never commit. Agents never git-push. Agents never run destructive git.

### Review
- When an agent returns, read its writeup/deliverable.
- Re-run the gate locally: `bun run lint && bun run typecheck && bun run test && bun run agent-ci` — all must exit 0.
- If the agent flagged a deviation from PLAN.md: either accept + fold into PLAN.md, or reject + re-spawn.
- Spot-check key files. An agent's summary describes what it *intended* to do, not necessarily what it did.

### Commit + land (PR-based since Phase 5.C's branch protection)
- `main` is protected: direct pushes are rejected. Every change lands via a feature branch + PR.
- **Branch naming:** `shamu/<kind>/<slug>` — `<kind>` ∈ `{phase,chore,fix,docs}`. Examples: `shamu/phase/6a-linear-auth-client`, `shamu/chore/pr-workflow-adoption`.
- Targeted `git add <specific files>` on the branch, never `-A` while sibling tracks are in flight.
- One track per branch per PR where possible. Sibling tracks become sibling branches + sibling PRs.
- Detailed commit body: what landed, why, notable decisions, followups for later phases. PR body summarizes the same, structured as `## Summary` + `## Test plan`.
- Update PLAN.md checkboxes **in the same PR** the track is delivered in (tick as you go).
- **Merge method: squash.** Classic protection enforces linear history; rebase-merges can't be auto-signed by GitHub and get rejected by `required_signatures`. Squash lets GitHub sign the resulting commit via web-flow.
- **Self-merge is intended.** Ruleset has `required_approving_review_count: 0` by design (solo author + solo reviewer; see `scripts/setup-branch-protection.sh` rationale comment). The `ubuntu-latest` status check is the load-bearing quality bar.

### Close the phase
- After all track PRs merge, open a close-out PR:
  - Any PLAN.md section edits made in response to this phase's findings
  - HANDOFF.md refresh (status table, "next" section, followups)
- Exit-criterion check against PLAN.md; if not met, the phase isn't done.

## Sub-agent prompt template

Every prompt includes:

1. **Identity.** "You are executing Track X.Y of Shamu…" + project root path.
2. **Context.** Which PLAN.md sections to read, which `docs/phase-N/` writeups are relevant.
3. **Mission.** One paragraph: what's being built, why, what already exists.
4. **Deliverables.** Concrete file list + per-file expectations + acceptance criteria.
5. **Constraints (always include):**
   - Work only in `<assigned paths>`. Don't touch sibling packages, PLAN.md, or `docs/phase-*/`.
   - Don't commit. Don't run destructive git. Leave work unstaged for parent review.
   - Run `bun run lint && bun run typecheck && bun run test && bun run agent-ci` before declaring done; all must exit 0.
   - Pin dependencies exactly (no `^`/`~`). Install with `bun install --frozen-lockfile --ignore-scripts`.
   - `verbatimModuleSyntax` is on — `import type` for type-only imports.
   - No `any` (Biome rejects).
6. **Hand-off format.** ≤ 400 words: what landed, gate outputs, coverage, design decisions, followups.

## Verification gates — non-negotiable

Before any commit:

```
bun run lint        # Biome, must be clean
bun run typecheck   # TypeScript strict across all packages
bun run test        # full workspace (Vitest + bun test under turbo)
bun run agent-ci    # @redwoodjs/agent-ci local CI run
```

If any gate is red, do not commit. Fix or re-spawn.

## Commit discipline

- **Body-heavy commits.** Subject ≤ 72 chars; body explains what, why, decisions, followups. `git log` is a secondary decision log — keep it useful.
- **Never `--no-verify`, never `--no-gpg-sign`.** The gate is a wall, not a suggestion.
- **Targeted `git add`.** `git add -A` is dangerous while parallel tracks are unfinished — you'll snapshot half-state.
- **Never amend published commits.** Always a new commit. Amending pre-push commits to fix a missed signature is allowed (and in fact necessary when the signing config was absent at first commit time).
- **No destructive git** (force-push, `reset --hard`, `branch -D`, `clean -f`) without explicit user approval.
- **Signed commits.** Local setup: `gpg.format=ssh` + `user.signingkey=<path to public key>` + `commit.gpgsign=true`. The signing SSH key must be registered on GitHub as `--type signing` (separate from the auth SSH key). Verify on push with `git log -1 --show-signature`; `%G?=N` is a local-verification display quirk when `gpg.ssh.allowedSignersFile` is unset and does **not** mean the commit is unsigned — check the raw commit with `git cat-file commit HEAD | grep ^gpgsig` instead.

## Known recurring constraints

From Phase 0 spikes + Phase 1 experience. Internalize these:

- **Node-style `drain` backpressure** on vendor subprocess stdin. Every vendor CLI is Node-based; Bun fire-and-forget writes break Claude/Codex under load.
- **git 2.50 rejects `-q`** on `git revert` and `git worktree prune`. Redirect output instead.
- **`bun:sqlite` cannot load under Vitest workers.** `@shamu/persistence` uses `bun test`. Wired through `turbo run test`. Don't port back.
- **Capabilities are immutable.** Loaded from a frozen manifest; adapters cannot upgrade themselves at runtime (T8/G8).
- **`runId` is orchestrator-owned** from Phase 2 onward. Supervised adapters accept it via `SpawnOpts`; never mint their own.
- **`from_agent` on mailbox writes** is orchestrator-assigned from authenticated run context (G6). Never accept from payload.
- **Path-scope enforced at tool-dispatch time** in the adapter permission handler (G4). Pre-commit is defense in depth only.
- **Shell AST gate** via `shell-quote`. Default reject-list: `$()`, backticks, `eval`, pipes-to-shell, process substitution.
- **`GITHUB_REPO` env** must be set from the worktree's `origin` remote before spawning agent-ci.
- **`agent-ci` run status** is derived from workflow + job statuses, NOT from top-level `run-state.status` (fire-and-forget save).
- **Docker containers** need reaping (`agent-ci-<n>`) on SIGTERM to agent-ci.
- **Egress broker lands by Phase 7**, not Phase 8. Full-autonomy-as-goal means G2 is earlier than originally planned.

## When to pause for user input

Stop and ask before proceeding when:

- A new architectural decision isn't already answered in PLAN.md or HANDOFF.md's "already-answered decisions."
- Secrets, API keys, or credentials are needed and can't be reached via keychain.
- A destructive action seems necessary (force-push, branch delete, `--no-verify`).
- An adversarial-review finding contradicts the plan and requires re-scoping.
- A vendor SDK rejects the documented auth path.
- A manual-testing step is needed (the user has a standing offer to manually test).

Never silently work around a blocker. Stop, write up, hand back.

## Checkbox + HANDOFF discipline

- **Tick PLAN.md boxes in the track's own commit**, not in a batch at phase end. Drift accumulates otherwise.
- **Update HANDOFF.md at every phase boundary** — status table, "next" section, followups list, open questions. Commit separately from track work.
- **Fold small decisions into PLAN.md where they're contextual** (adapter contract, mailbox section, etc.). Don't create a separate `DECISIONS.md` — those files rot.
- **Session-mid handoff:** if the session ends mid-phase with work in flight, note the in-flight agents + expected outputs in HANDOFF under "What's in flight."

## Meta-rules

- **Trust but verify sub-agent output.** Their summaries say what they *intended*. Run the gate yourself; spot-check files.
- **Propose PLAN.md changes openly.** If a phase reveals the plan is wrong, edit it, justify in the commit body, proceed. Don't silently drift.
- **Prefer editing existing files over adding new ones.** Most tracks should touch existing structures.
- **No emoji in code or logs.** Liability in CI + screen readers. Plain text.

## Cross-session continuity

Things that persist (rely on these):

- `HANDOFF.md` — fresh-session entry point.
- `PLAN.md` — architecture + phased delivery + decisions + open questions.
- `docs/phase-N/*.md` — spike writeups, evidence logs.
- Commit bodies — secondary searchable decision log.
- `AGENTS.md`/`CLAUDE.md` — GitNexus-generated code context.

Things that DON'T persist (don't rely on them):

- `TaskCreate`/`TaskList` state — session-scoped, dies with the session.
- In-session agent history — gone on session end.
- Ephemeral scratch files not committed to git.

HANDOFF.md replaces the task list for anything that must survive the session.
