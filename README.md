# Shamu

A single-box, single-user multi-agent coding orchestrator that runs heterogeneous
coding agents (Claude, Codex, Cursor, OpenCode, Pi, Gemini, Amp) as a supervised
swarm, gated by `agent-ci` before any patch is allowed to merge.

[![CI](https://github.com/watzon/shamu/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/watzon/shamu/actions/workflows/ci.yml)

## What it does

- **Runs a swarm, not a single agent.** One thin adapter per vendor, one shared
  `AgentEvent` stream, one supervisor tree with OTP-shaped restart policies.
- **SQLite is the queue.** Events, mailbox, leases, audit log, and flow state all
  live in one WAL-mode database; short-lived CLI processes claim work via
  `UPDATE ... RETURNING`. No Redis, no broker daemon.
- **Linear is the work intake.** A Linear label (`shamu:ready`) triggers webhook
  pickup; the canonical plan-execute-review flow drives the run; the rolling
  comment + status flip reports progress back.
- **`agent-ci` is the gate.** No patch is marked "approved" without a green
  `@redwoodjs/agent-ci` run on the integration branch. Branch protection on
  `main` makes the gate unbypassable server-side.
- **Vendor adapters.** Claude, Codex, Cursor, OpenCode, Pi, Gemini, Amp, plus an
  in-memory `echo` adapter for tests. Each passes a shared 13-scenario contract
  suite before landing.

## Requirements

- [Bun](https://bun.sh) 1.3.11 or newer
- Node.js 22+ (only needed so `@redwoodjs/agent-ci` can spawn its Docker runner)
- Docker (only needed by `agent-ci`)
- git 2.50+
- macOS or Linux. Windows is not a supported deploy target.

## Quick start

```sh
git clone https://github.com/watzon/shamu.git
cd shamu
bun install --frozen-lockfile
bun run typecheck
bun run test
bun shamu doctor
bun shamu run --adapter=echo --task=hello
```

`shamu doctor` surfaces keychain wiring, clock skew, audit-chain integrity, and
egress-broker reachability. `shamu run --adapter=echo` exercises the full event
pipeline (spawn → events → persistence → exit-code projection) without a real
vendor CLI.

The local CI gate mirrors what GitHub Actions runs:

```sh
bun run lint        # Biome
bun run typecheck   # tsc --noEmit + per-package typecheck
bun run test        # vitest + bun test (for bun:sqlite packages) under turbo
bun run agent-ci    # @redwoodjs/agent-ci against .github/workflows/ci.yml
```

## Running a flow

The canonical `plan-execute-review` flow drives a planner (GPT-5.4) → executor
(Opus 4.7) → reviewer (GPT-5.4) loop until the reviewer approves or the max
iteration count is hit:

```sh
bun shamu flow run plan-execute-review --task "describe the change"
bun shamu flow status <flow-run-id>
```

Flows resume against their last completed node if the process dies mid-run.

## Running the web dashboard

```sh
bun shamu ui
```

Boots `@shamu/web` (Hono server + SolidJS frontend) in-process, binds to
`127.0.0.1`, and opens the default browser. The dashboard is read-only: an SSE
feed over the same `AgentEvent` stream the CLI consumes, plus stable `/run/<id>`
URLs. Pass `--no-open` to print the URL instead of launching a browser. See
`apps/web/` for the server internals.

## Running the Linear daemon

For long-lived autonomous operation, `shamu linear serve` subscribes to Linear
webhooks, picks up `shamu:ready` issues, runs the canonical flow, and flips the
issue status on completion or escalation.

```sh
bun shamu linear tunnel          # provision a cloudflared route for the receiver
bun shamu linear serve            # long-lived daemon
```

Phase 8.A owns the autonomous loop; soak-test notes live in
[`docs/phase-8/soak-test.md`](./docs/phase-8/soak-test.md), and the daemon's
drain semantics are documented in the header of
[`apps/cli/src/commands/linear/serve.ts`](./apps/cli/src/commands/linear/serve.ts).

## Architecture at a glance

Shamu is a Bun monorepo. The CLI spawns adapter subprocesses, each event
normalizes into an `AgentEvent` envelope, every envelope is persisted to SQLite
by the core, and read-models (CLI, web dashboard, future TUI) subscribe to the
same stream. The supervisor owns restart; the watchdog runs out-of-process
against a read-only SQLite handle so a stalled main process can't silence it;
the egress broker enforces per-run network allow-lists before Phase 8's
container-based sandbox replaces it.

Full writeup — packages, adapter contract, event taxonomy, protocols, layering
rules — lives in [`docs/architecture.md`](./docs/architecture.md).

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Shamu is being built *by* a swarm of
coding agents; the pipeline that drives that swarm is documented in
[`.claude/skills/shamu-dev/SKILL.md`](./.claude/skills/shamu-dev/SKILL.md) and
the current state of work lives in [`HANDOFF.md`](./HANDOFF.md).

## Security

Shamu runs semi-trusted agent behavior with shell, filesystem, and network
access. The mitigations are enumerated in
[`docs/threat-model-summary.md`](./docs/threat-model-summary.md); the full
threat model is at [`docs/phase-0/threat-model.md`](./docs/phase-0/threat-model.md).

Report security issues privately rather than via a public issue.

## License

MIT — see [LICENSE](./LICENSE).
