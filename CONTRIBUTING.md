# Contributing to Shamu

Shamu is a single-user, single-box multi-agent coding orchestrator. It is being
built *by* a swarm of coding agents, which means two audiences contribute here:
humans reviewing AI-authored PRs, and agents executing tracks inside a
long-running session. The rules below are the same for both.

## Quick orientation

Before editing anything, read (in order):

1. [`HANDOFF.md`](./HANDOFF.md) — current phase, what's next, what's in
   flight, user-owed answers. This is the freshest state.
2. [`PLAN.md`](./PLAN.md) — the living architecture doc + phased delivery
   table. Every track cites a section here.
3. [`.claude/skills/shamu-dev/SKILL.md`](./.claude/skills/shamu-dev/SKILL.md)
   — the pipeline contract (intake → swarm → verify → commit → close),
   parallel-agent git-safety rules, and recurring constraints.
4. [`docs/architecture.md`](./docs/architecture.md) — packages, adapter
   contract, event taxonomy, protocols, layering rules.
5. [`docs/threat-model-summary.md`](./docs/threat-model-summary.md) — which
   mitigation contract (G1–G11) your change has to preserve.

Anything you can't answer from those five files is either an open question
(raise it on the PR) or a sign that PLAN.md needs an edit.

## Local setup

```sh
git clone https://github.com/watzon/shamu.git
cd shamu
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run test
bun run agent-ci
```

### Commit signing

`main` requires signed commits. SSH signing is the supported path:

```sh
git config --global gpg.format ssh
git config --global user.signingkey /absolute/path/to/your.ssh.pub
git config --global commit.gpgsign true
```

Register the public key on GitHub as **type: signing** (distinct from the auth
SSH key — GitHub rejects auth-only keys for verification). Verify locally:

```sh
git commit --allow-empty -m "smoke: signing works"
git log -1 --show-signature
git cat-file commit HEAD | grep ^gpgsig
```

`%G?=N` from `git log --show-signature` is a display quirk when
`gpg.ssh.allowedSignersFile` is unset; the `gpgsig` header on the raw commit
is what matters.

## Code style

- **Biome** for lint + format. `bun run lint` must exit 0; autofix with
  `bun run lint:fix`.
- **TypeScript strict** across every package. `verbatimModuleSyntax` is on —
  always use `import type { ... }` for type-only imports.
- **No `any`.** Biome rejects; prefer `unknown` + narrowing.
- **Pin dependencies exactly.** No `^` / `~` in `package.json`. Supply-chain
  rule G9 (see `docs/threat-model-summary.md`).
- **No emoji** in code, logs, commit messages, or docs. They are a liability
  in CI log grepping and with screen readers.
- **Prefer editing existing files over creating new ones.** Most tracks should
  extend an existing module, not add a sibling.

## Tests

- **Vitest** per package for most tests. `turbo run test` fans out.
- **`bun test`** (not Vitest) for packages that touch `bun:sqlite`. `bun:sqlite`
  cannot load under Vitest workers; `@shamu/persistence` uses `bun test` for
  this reason. Wired through `turbo run test` — do not port back.
- **Contract suite** — every adapter must pass `runAdapterContractSuite` from
  `@shamu/adapters-base/contract`. 13 scenarios today. Capability-skipped
  scenarios log loudly; silent skips would let capability regressions through.
- **Coverage bars** — `packages/core`, `packages/adapters/base`,
  `packages/watchdog`, `packages/mailbox` require ≥ 80% Vitest coverage.
- **Snapshot tests on normalized event streams** so a vendor SDK drift can't
  silently corrupt the projection.

Run the full gate before asking for a review:

```sh
bun run lint && bun run typecheck && bun run test && bun run agent-ci
```

All four must exit 0.

## Commit discipline

- **Body-heavy commits.** Subject ≤ 72 chars. Body explains *what* landed,
  *why* (reference PLAN.md sections), notable decisions, and followups for
  later phases. `git log` is a secondary searchable decision log.
- **Signed commits always.** Never `--no-verify`, never `--no-gpg-sign`.
- **Targeted `git add`.** `git add -A` and `git add .` are dangerous when
  parallel tracks are in flight; you will snapshot half-state from a sibling
  agent. Name files individually.
- **Never amend published commits.** Amend only an unpushed commit to fix a
  missed signature (this is how you recover when signing config was missing
  at first commit time). All other fixes are new commits.
- **No destructive git** — no `git reset --hard`, no `git checkout -- .`,
  no `git clean -f`, no `git stash drop`, no `git branch -D`, no force-push,
  without explicit user approval. Parallel agents share the working tree;
  "cleaning up" sibling changes has destroyed hours of work.

## PR workflow

- **Branch naming:** `shamu/<kind>/<slug>` where `<kind>` ∈
  `{phase, chore, fix, docs}`. Examples:
  `shamu/phase/8a-autonomous-loop`, `shamu/docs/contributing-guide`,
  `shamu/chore/pin-biome`.
- **One track per branch** where possible. Sibling tracks become sibling PRs.
- **Update PLAN.md checkboxes in the track's own PR.** Drift accumulates
  otherwise. The close-out PR at phase end handles HANDOFF + PLAN refreshes
  that touch multiple tracks.
- **PR body:** `## Summary` (1–3 bullets, the why) + `## Test plan` (bulleted
  checklist reviewers can replay).
- **Required status check:** `CI / ubuntu-latest` is the load-bearing gate.
  Per-adapter `contract:<vendor>` jobs run additively on every PR; adding or
  removing an adapter doesn't need a branch-protection update.
- **Merge method: squash.** Classic branch protection enforces linear
  history and requires GitHub-signed commits; rebase-merges can't be
  auto-signed. Squash lets GitHub sign the result via web-flow.
- **Self-merge is intended.** Ruleset has `required_approving_review_count:
  0` by design (solo author + solo reviewer). The status check is the wall.

## Agent development (meta)

Shamu is orchestrated by its own pipeline. If you are authoring changes as
an agent (or directing one), the full contract is in
[`.claude/skills/shamu-dev/SKILL.md`](./.claude/skills/shamu-dev/SKILL.md).
Cliff-notes for parallel runs:

- **Work only in your assigned paths.** Sibling tracks own non-overlapping
  paths; don't touch `HANDOFF.md`, `PLAN.md`, or `docs/phase-*/` unless your
  track owns them.
- **Don't commit, push, or run destructive git.** Agents leave work unstaged
  for parent review. A 2026-04-18 incident destroyed ~1000 lines of a sibling
  agent's uncommitted work when one agent ran a "defensive" `git reset`.
- **Don't switch branches mid-task.** Stay on the branch you were launched
  onto. If the branch isn't what you expect, stop and flag.
- **Use worktree isolation** (`.claude/worktrees/<agent-id>`) if you need
  an isolated git tree per agent; parallel agents in the same tree is the
  dangerous mode.
- **Don't run `bun install`** unless a deliverable genuinely needs a new
  dependency. Sibling-track lockfile races create coordination bugs.
- **Verify before handoff:** `git status` and run the gate
  (`lint && typecheck && test && agent-ci`). Brand-new files should show
  up in `git status --short` as `??`.

## Reporting bugs and proposing changes

- **Bugs** — open a GitHub issue. Include: Shamu version (commit SHA), OS,
  Bun version, the CLI invocation, and the redacted event stream from
  `shamu logs --json --run <run-id>` if relevant.
- **Architecture proposals** — PLAN.md is the living design doc. Draft a PLAN
  edit as part of the PR; don't create standalone design docs that will rot.
- **Security issues** — report privately rather than via a public issue.
  Threat model details are in `docs/threat-model-summary.md`.
