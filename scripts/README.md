# scripts/

Dev-laptop tooling. These are helpers run by humans (or by the shamu
supervisor in its own workspace); they are not part of the orchestrator
runtime. Shamu itself is dev-laptop-only per PLAN.md — it never runs
inside GitHub Actions — and the same applies to anything in this
directory.

## `agent-ci.ts`

Shims `@redwoodjs/agent-ci` so it boots with `GITHUB_REPO` set (the
dependency crashes otherwise). Invoked via the root package alias
`bun run agent-ci`, which maps to `bun scripts/agent-ci.ts`.

See the script header for flag forwarding details.

## `build-release.ts`

Drives `bun build --compile` to produce a single-binary build of the
`shamu` CLI for distribution (Phase 8.C Track 8.C.2). Emits NDJSON
progress events on stdout so a CI driver can parse the stream; writes
the binary plus a matching `<binary>.sha256` file into the output
directory.

```sh
# Build for the host target (darwin-arm64 or linux-x64)
bun scripts/build-release.ts

# Build a specific target
bun scripts/build-release.ts --target=darwin-arm64
bun scripts/build-release.ts --target=linux-x64

# Build all supported targets into a custom outdir
bun scripts/build-release.ts --target=all --outdir=./dist/release
```

The Claude adapter needs a ~200MB per-platform `claude` CLI binary that
`bun build --compile` cannot absorb (confirmed in
`docs/phase-0/bun-compat.md` Test 3); the adapter's
`ensureClaudeSidecar()` bootstrap downloads and verifies that binary on
first run. See
[`docs/phase-8/release-binaries.md`](../docs/phase-8/release-binaries.md)
for the full release story.

### Smoke test

`scripts/build-release.test.ts` contains a gated smoke that invokes
`buildOneTarget` against the host architecture into a temp dir and
asserts the outputs exist. It's gated so it doesn't slow down
`bun run test`:

```sh
SHAMU_RELEASE_BUILD_SMOKE=1 bun test scripts/build-release.test.ts
```

Omit the env flag and the smoke is skipped.

## `setup-branch-protection.sh`

Bootstraps GitHub branch protection for this repo. Shamu's quality gate
(PLAN.md Phase 5.C) requires the `CI / ubuntu-latest` status check,
signed commits, and linear history on `main`; the integration branches
created by the orchestrator (`shamu/integration/*`) need the same
guarantees.

Branch protection lives outside the git tree — the GitHub API is the
only way to apply it — so this script is the delivery vehicle.

### Preconditions

- `gh` CLI installed and on `PATH` (<https://cli.github.com/>).
- `gh auth status` is green.
- The authenticated user has **Admin** access to the target repo.
  Rulesets and branch-protection endpoints both require it.

### Usage

```sh
# Auto-detect owner/repo from `git remote get-url origin`
scripts/setup-branch-protection.sh

# Explicit repo
scripts/setup-branch-protection.sh watzon/shamu

# Or via env
GITHUB_REPO=watzon/shamu scripts/setup-branch-protection.sh

# Dry-run: prints the gh api calls without executing them
scripts/setup-branch-protection.sh --dry-run
```

### What gets applied

Two rulesets (modern API, pattern-aware):

- `shamu-main-protection` targeting `refs/heads/main`
- `shamu-integration-protection` targeting `refs/heads/shamu/integration/*`

Each ruleset enforces:

- Required status check: `CI / ubuntu-latest` (strict — branch must be
  up to date with base before merge).
- Required signed commits.
- Required linear history.
- Required pull-request review (1 approval, dismiss stale on push).
- Disallowed force pushes.
- Disallowed deletions.

Plus classic branch protection on `main` (`PUT /repos/{owner}/{repo}/branches/main/protection`)
as a fallback for tools that still read the old endpoint. `required_signatures`
is toggled via its dedicated sub-endpoint because some API versions
reject it inside the classic PUT body.

### Idempotency

Safe to re-run. The script upserts by ruleset name (looks up the
existing ID and PUTs into it); the classic endpoint is PUT semantics.

### Scope

This is dev-laptop tooling. It mutates live GitHub settings — the
watchdog test suite does not exercise it, the orchestrator does not
invoke it, and agent-ci does not run it. One human, one `gh` token,
one execution per repo bootstrap.
