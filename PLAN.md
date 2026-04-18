# Shamu — Multi-Agent Superharness

An agent-agnostic orchestrator that runs heterogeneous coding agents (Claude, Codex/GPT-5.4, Cursor, OpenCode, Pi, Kimi, Gemini, Amp, …) as a swarm, with inter-agent messaging, supervisor-driven watchdogs, Linear integration, and `agent-ci` as a first-class quality gate.

## Design principles

1. **Adapters, not abstractions-over-adapters.** One thin interface per vendor. No 4-layer capability model that tries to normalize "what an agent can do."
2. **SQLite is the canonical store.** One SQLite database holds events, mailbox, leases, queue, and audit log. Files on disk (worktrees, mailbox exports) are debug/human surfaces, not second sources of truth. No long-lived daemon until Phase 8 (autonomous mode); every earlier command is a short-lived process.
3. **Supervisor is the control plane.** OTP-shaped: one-for-one restarts, bounded intensity, explicit restart policy per role. Out-of-process watchdog so a stuck worker can't vouch for itself.
4. **Resumable and cheap.** Persist vendor session IDs so warm-resume is the default. Cache strategy is vendor-specific (Anthropic's 5-min TTL, Codex's thread state, OpenCode's SQLite sessions); each adapter owns its cache hygiene. The core does not pretend one model fits all vendors.
5. **Quality is a gate, not a suggestion.** Every agent patch runs through `agent-ci` before it can merge toward the integration branch. Enforcement is **branch protection + required status check + signed commits** — not a server-side `--no-verify` detector (which doesn't exist: servers can't see client-side hook flags). `--no-verify` is irrelevant if the required check fails to appear.
6. **Multi-signal stuck detection.** Progress checkpoints + state-change fingerprint + token-velocity + repeat-call fingerprint. Never single-signal.

## Why these choices (from research)

- OpenCode, ccswarm, Claude's own "Agent Teams," and mcp_agent_mail have all converged on **git-worktree + file-mailbox + lead/peer** as the minimal viable swarm substrate — not a coincidence worth fighting.
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.2.x) and Codex SDK (`@openai/codex-sdk`) are both **subprocess + JSONL event stream** under the hood. OpenCode, Pi, Amp, Gemini CLI, Aider, Q all fit the same shape. **Three adapter templates cover the entire market:** (a) subprocess + JSONL/SSE, (b) cloud REST + webhook (Cursor, Jules), (c) OpenAI-compatible chat + our own tool loop (Kimi + fallback).
- MCP 2025-11-25 for **agent↔tool**; A2A v1.0 (Signed Agent Cards, LF-governed) for **agent↔agent** if/when we leave a single box. Not ACP (dead).
- Linear MCP server + **webhooks, not polling**, as the work-intake signal. Linear's own rate-limit docs specifically tell clients not to poll.
- SQLite-as-queue beats Redis/NATS/Kafka for a single-box harness running 5–10 concurrent agents. Zero deps, durable, transactional with the rest of our state.

## Language & runtime

**TypeScript on Bun.** Every major agent SDK ships a first-class TS client (Claude, Codex, OpenCode, Pi, Amp, Gemini CLI). Bun gives fast startup, built-in SQLite, `Bun.spawn` for clean subprocess IO, and a single-binary build story (`bun build --compile`). Python would force an extra shell-out for the Codex/OpenCode/Pi native SDKs — not worth it.

**Bun is validated, not assumed.** Phase 0 runs the Claude and Codex SDKs under Bun against their real event streams and exercises SQLite WAL concurrency under 5–10 concurrent agents. Any package where Bun misbehaves declares `engine: node` and falls back; the monorepo is package-level-runtime-agnostic, and CI matrices both runtimes for adapter packages until we're confident.

## Repository layout

```
shamu/
├── apps/
│   ├── cli/                  # `shamu` CLI (run, attach, status, logs, kill)
│   └── tui/                  # optional Ink-based TUI (later)
├── packages/
│   ├── core/                 # Supervisor, scheduler, event bus, queue
│   ├── adapters/
│   │   ├── base/             # Adapter contract + shared subprocess helpers
│   │   ├── claude/           # @anthropic-ai/claude-agent-sdk adapter
│   │   ├── codex/            # @openai/codex-sdk adapter
│   │   ├── opencode/         # @opencode-ai/sdk adapter
│   │   ├── pi/               # @mariozechner/pi-coding-agent adapter
│   │   ├── cursor/           # REST + webhook adapter
│   │   ├── kimi/             # OpenAI-compatible + own tool loop
│   │   ├── gemini/           # gemini-cli-sdk adapter
│   │   └── amp/              # Sourcegraph Amp adapter
│   ├── mailbox/              # File-mailbox + advisory file leases
│   ├── worktree/             # git worktree lifecycle + cleanup
│   ├── watchdog/             # Heartbeat + stuck-detector
│   ├── linear/               # Linear MCP client + webhook receiver
│   ├── ci/                   # agent-ci integration (gate + reporter)
│   ├── persistence/          # SQLite schema, migrations, queries
│   ├── protocol/             # A2A server/client (Phase 8)
│   └── shared/               # Types, logger, errors
├── config/
│   ├── shamu.config.ts       # User config (swarm topology, roles, CI)
│   └── schemas/              # Zod schemas for config + events
├── tests/
│   ├── unit/
│   ├── integration/          # Real subprocess adapters, mocked network
│   └── e2e/                  # End-to-end with throwaway Linear project
├── .github/workflows/ci.yml  # agent-ci + lint + typecheck + tests
├── agent-ci.yml              # agent-ci config for THIS repo (dogfooding)
├── PLAN.md
└── README.md
```

## UI plan

### Philosophy

One event stream, three consumers. The core is already headless and event-sourced — every `AgentEvent` hits SQLite and an in-memory bus. The CLI, TUI, and web dashboard are **read-models over that stream**; no domain logic lives in the UI. This is what lets shamu dodge Claude Code's tmux/iTerm dependency and stay portable.

All three surfaces live in the same monorepo (TypeScript, Bun) so types, event schemas, and formatting helpers are shared.

### Surface 1 — CLI (lands Phase 1)

Headless, scriptable, CI-friendly. First-class citizen, not an afterthought.

- Commands: `run`, `resume`, `status`, `logs`, `kill`, `attach`, `flow run`, `flow status`, `doctor`, `linear tunnel`.
- Output: human text by default, `--json` for piping, `--watch` for tail-follow.
- Exit codes meaningful (distinct codes for `agent-ci` red vs supervisor escalation vs user-cancel) so shell pipelines and cron can react.
- Works over SSH with zero setup — no terminal multiplexer needed.

### Surface 2 — TUI (lands Phase 3)

Full-screen terminal dashboard built on **Ink** (React-for-terminals, Bun-compatible). Feels like `k9s` / `lazygit`: panels, keyboard-driven, vim-y bindings, mouse optional.

**Views**

- **Swarm overview (`shamu tui` home)**
  - Header: swarm name, wall-clock, aggregate cost today, active run count.
  - Left: run list, color-coded by status (running/review/blocked/done). Filterable by Linear label, vendor, flow.
  - Right: selected-run summary — current flow node, elapsed, per-role cost, latest checkpoint.
- **Run detail (`enter` on a run)**
  - Top: issue title + link, flow DAG (plan→execute→review→loop) with current node highlighted.
  - Middle: split-pane per active agent showing live event stream — assistant deltas, tool calls, tool results. Each pane is an independent `Ink` subscription; no single-stream bottleneck.
  - Bottom: mailbox (agent↔agent messages for this run), CI badge with last result, watchdog signals.
  - Controls: `i` interrupt, `m` change model, `p` change permission mode, `k` kill, `R` restart under supervisor, `f` follow-tail, `/` filter.
- **Supervisor tree (`shamu tui sup`)**
  - Visual tree of supervisor → role → worker. Restart counts, policies, last-escalation reason.
- **Mailbox inspector (`shamu tui mail`)**
  - All messages across the swarm, threaded by recipient. Useful for debugging coordination.
- **Log explorer (`shamu tui log`)**
  - Searchable event log across all runs; filter by run/agent/tool/kind/date.
- **Status bar** (every view): watchdog indicator, queued runs, API-rate-limit budget per vendor, unread escalations.

**Why Ink vs plain TTY redraw:** Ink gives us a React component model so panes are composable and events are diffed (no flicker). Components do **not** reuse in the web dashboard — terminal primitives aren't DOM and pretending otherwise leads to two half-finished UIs. What reuses across TUI and web: the event-formatter layer (`packages/shared/format`), design tokens, view models (derived from the SQLite event projection), the SSE subscription pattern, and the keyboard-binding table. Components get rewritten per surface.

### Surface 3 — Web dashboard (lands Phase 7)

Richer local view — graphical DAGs, diff viewer, charts — running alongside the CLI/TUI. **Single-user, on-device, no auth, no team mode.**

- **Stack:** Hono (Bun-native HTTP) + **SolidJS** frontend. Fine-grained reactivity is a clean fit for a constantly-updating event stream; bundle is small; no virtual-DOM tax.
- **Transport:** Server-Sent Events from the Bun server, reusing the exact `AgentEvent` schema. One-way push — simpler than WebSockets and fits the read-model pattern.
- **Binding:** `127.0.0.1` only. No OIDC, no session cookies, no team mode. `--unsafe-bind` exists as an explicit escape hatch for LAN-accessible setups and prints a banner; even then, authentication is out of scope for v1.
- **Storage:** read-only over the same SQLite database the CLI/TUI use — no separate store.
- **Layout:** mirrors the TUI screens but with richer affordances —
  - Flow DAG rendered as a proper graph (not ASCII), zoomable.
  - Diff viewer for patches produced by the executor (before/after, hunks highlighted).
  - CI output inline with collapsible failure groups (using the fixtures+parser shape from Phase 0.D).
  - Linear issue embed in a side-drawer (via Linear's issue-preview OEmbed).
  - Cost/usage charts (per-run, per-role, per-vendor, last 7/30 days).
- **Stable URLs:** every run has a stable URL (`/run/<id>`) for bookmarking — no ACLs because there's one user.

### Shared design elements (across TUI + web)

- **Event formatters** (`packages/shared/format`): one canonical way to render each `AgentEvent` as a line — reused by CLI logs, TUI panes, and web log views.
- **Color palette**: accessible (WCAG AA), terminal-safe subset used by TUI; extended palette for web. One source of truth (JSON tokens).
- **Copy**: terse, scanable. No emoji in default output — they're a liability in CI logs and screen readers.
- **Keyboard parity**: TUI bindings mirror vim/k9s conventions; web dashboard exposes the same bindings (and shows them in a `?` overlay).

### Task breakdown

**Phase 1 — CLI (Serial with other Phase 1 work)** ✅
- [x] Citty command framework with per-command `--json` + `--watch`
- [x] `run`, `resume`, `status`, `logs`, `kill`, `attach` scaffolds (run/status/logs wired to real SQLite; kill/attach/resume await Phase 3's supervisor)
- [ ] Canonical event formatter (`packages/shared/format`) — **deferred**: there is only one surface (CLI) in v1; formatter lives inline in `apps/cli/src/output.ts` and will be hoisted to `packages/shared/format` when the TUI lands in Phase 3
- [x] Exit-code taxonomy documented and enforced
- [x] `shamu doctor` env/auth health check (initially a stub; filled in each phase)

**Phase 3 — TUI (Parallel with Phase 3 supervisor/mailbox work)**
- [ ] `apps/tui` Ink bootstrap; route/view component model
- [ ] Swarm overview view (list + summary, SQLite subscription)
- [ ] Run detail view (flow DAG + per-agent panes + mailbox + CI badge)
- [ ] Supervisor tree view
- [ ] Mailbox inspector view
- [ ] Log explorer view with filter/search
- [ ] Keyboard bindings + `?` help overlay
- [ ] Accessibility: screen-reader-friendly fallback mode (`--simple`)

**Phase 7 — Web dashboard (Track 7.H — Parallel with adapter fan-out)**
- [ ] Hono server in `apps/web` with SSE endpoint over `AgentEvent`; binds to `127.0.0.1` only
- [ ] SSE `Origin` allow-list (default `http://127.0.0.1:*`; `--unsafe-bind` requires explicit addition)
- [ ] SolidJS frontend scaffold + router + design tokens
- [ ] Swarm overview page
- [ ] Run detail page with DAG visualization (D3 or Cytoscape)
- [ ] Diff viewer for executor patches
- [ ] CI output viewer with collapsible groups (reuses Phase 0.D parser)
- [ ] Cost/usage charts (last 7/30/90 days)
- [ ] Stable run URLs (`/run/<id>`) for bookmarking

**Phase 8 — UI ops polish (folds into Track 8.C in the Phased delivery section below)**
- [ ] `bun build --compile` packages CLI + TUI + web into a single binary
- [ ] `shamu ui` command opens the web dashboard in the default browser
- [ ] Screenshot CI: every PR gets TUI + web screenshots captured via headless render (helps reviewers see UI changes)

### Non-goals for v1

- **No IDE extension.** A Zed ACP bridge or VS Code extension is plausible later, but each is a second product. Ship the three surfaces first.
- **No custom designer tool.** Flow DAGs are edited as TypeScript, not a drag-and-drop canvas.
- **No multi-tenant SaaS.** Local-first with optional OIDC; hosted mode is deliberately out of scope until there's demand.

## Core architecture

### 1. Adapter contract (`packages/adapters/base`)

```ts
export interface AgentAdapter {
  readonly vendor: string;
  readonly capabilities: Capabilities;      // declared, not inferred

  spawn(opts: SpawnOpts): Promise<AgentHandle>;
  resume(sessionId: SessionId, opts: SpawnOpts): Promise<AgentHandle>;
}

export interface AgentHandle {
  readonly runId: RunId;                    // shamu-local; injected via SpawnOpts from Phase 2 onward
  readonly sessionId: SessionId | null;     // vendor id for resume
  readonly events: AsyncIterable<AgentEvent>;

  send(message: UserTurn): Promise<void>;
  interrupt(reason?: string): Promise<void>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  shutdown(reason: string): Promise<void>;
  heartbeat(): { lastEventAt: number; seq: number };
}
```

**Event model splits into raw vendor events and normalized projections.** No `extra` grab-bag — if a vendor concept affects core behavior, it gets a typed event kind or a capability flag. Every normalized event carries correlation IDs, a monotonic sequence, and a typed payload.

```ts
interface EventEnvelope {
  eventId: EventId;              // ULID, globally unique
  runId: RunId;
  sessionId: SessionId | null;
  turnId: TurnId;                // groups events belonging to one vendor turn
  parentEventId: EventId | null; // tool_result → tool_call, etc.
  seq: number;                   // monotonic within run
  tsMonotonic: number;
  tsWall: number;
  vendor: string;
  rawRef: RawEventRef | null;    // pointer into raw_events table
}

export type AgentEvent = EventEnvelope & (
  | { kind: "session_start"; source: "spawn" | "resume" | "fork" }
  | { kind: "session_end"; reason: string }
  | { kind: "reasoning"; text: string; signature?: string }
  | { kind: "assistant_delta"; text: string }
  | { kind: "assistant_message"; text: string; stopReason: string }
  | { kind: "tool_call"; toolCallId: ToolCallId; tool: string; args: unknown }
  | { kind: "tool_result"; toolCallId: ToolCallId; ok: boolean; summary: string; bytes: number }
  | { kind: "permission_request"; toolCallId: ToolCallId; decision: "pending"|"allow"|"deny"|"ask" }
  | { kind: "patch_applied"; files: string[]; stats: { add: number; del: number } }
  | { kind: "checkpoint"; summary: string }
  | { kind: "stdout" | "stderr"; text: string }
  | { kind: "usage"; model: string; tokens: Tokens; cache: CacheStats }
  | { kind: "cost"; usd: number | null; confidence: "exact"|"estimate"|"unknown"; source: string }
  | { kind: "rate_limit"; scope: "minute"|"hour"|"day"|"five_hour"|"other"; status: "ok"|"warning"|"exhausted"; resetsAt: number | null }
  | { kind: "interrupt"; requestedBy: "user"|"supervisor"|"watchdog"|"flow"; delivered: boolean }
  | { kind: "turn_end"; stopReason: string; durationMs: number }
  | { kind: "error"; fatal: boolean; code: string; message: string; retriable: boolean }
);
```

- **`reasoning`** is emitted by both Claude (`thinking` content blocks, with an optional `signature` cryptographic witness) and Codex (`reasoning` items). Dropping it would lose real signal the reviewer and watchdog consume.
- **`rate_limit`** is Claude-observed today (Codex signals similar conditions through `error`). Not an error — informational but **behavior-affecting** for scheduling + budgets.
- `turn.started` from Codex is *not* promoted to a kind — `turnId` on `EventEnvelope` plus `session_start` already scope turn membership unambiguously.

**Capabilities are declared, not inferred.** Core asks, never guesses. Capability declarations are **immutable** — read from a manifest file packaged with the adapter; the adapter process cannot upgrade/downgrade capabilities at event-emit time (G8 from threat model).

```ts
interface Capabilities {
  resume: boolean;
  fork: boolean;
  interrupt: "cooperative" | "hard" | "none";
  permissionModes: PermissionMode[];
  mcp: "in-process" | "stdio" | "http" | "none";
  customTools: boolean;
  patchVisibility: "events" | "filesystem-only";
  usageReporting: "per-turn" | "per-call" | "none";
  costReporting: "native" | "computed" | "subscription" | "unknown";
  sandboxing: "process" | "container" | "remote" | "none";
  streaming: "events" | "final-only";
}
```

**`SpawnOpts` carries a `vendorCliPath`** for pre-authenticated vendor CLIs, skipping env-var auth. Validated in 0.B: the Claude + Codex adapters thread this through as `pathToClaudeCodeExecutable` / codex CLI override. Load-bearing for the "user is already logged in" deploy path.

```ts
interface SpawnOpts {
  runId: RunId;              // orchestrator-owned; adapter does not mint its own
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  vendorCliPath?: string;
  allowedTools?: string[];
  maxTurns?: number;
  // extended per-adapter in Capabilities
}
```

**`runId` is orchestrator-owned** (from Phase 2 onward). Phase 1's echo adapter minted its own `runId` because no supervisor existed; Phase 2 vendor adapters require it via `SpawnOpts` so Phase 3's supervisor is authoritative and the adapter cannot fabricate identity.

**Path-scope is enforced at tool-dispatch time, not just pre-commit (G4).** The adapter's permission handler validates every filesystem tool-call path against the current worktree root before the tool runs: reject absolute paths outside the worktree, `..` escapes, and symlinks that resolve outside. The pre-commit guard is defense in depth, not the primary control.

**Shell-gate patterns match against a parsed AST, not raw command strings (G5).** Shamu's shared `PermissionMode` implementation parses with `shell-quote` (or equivalent) and rejects `$()`, backticks, `eval`, pipes-to-shell, and process substitution unless explicitly allow-listed. Adapters that route writes through structured tool APIs (`Edit`, `Write`) instead of `Bash` get this for free.

**Subprocess backpressure must be Node-compatible.** Phase 0.A found that every vendor CLI is a Node process, so the subprocess helper in `packages/adapters/base` must implement Node-style `drain` handling when writing to vendor stdin. Bun-style fire-and-forget writes break Claude/Codex binaries under load.

### 2. Event log (`packages/persistence/event-log`)

Two tables, one append-only, one projection.

- `raw_events(event_id, run_id, vendor, ts, payload_json)` — vendor output captured after **central secret redaction** on first write (G1 from threat model). Never schema-migrated, never edited after write. Retention is configurable (default 14 days; archive to cold storage before prune).
- `events(event_id, run_id, session_id, turn_id, parent_event_id, seq, ts_monotonic, ts_wall, vendor, kind, payload_json)` — normalized projection. Schema migratable. Redaction runs here too (same redactor, belt-and-braces).

Writes to `events` are idempotent on `event_id`; replays of `raw_events` regenerate `events` exactly. Projection migrations run by replaying the raw log against the new projector — no destructive schema-upgrade scripts. This also means vendor SDKs can drift and we can re-derive a correct `events` table without rerunning agents.

**A separate audit table, `audit_events`, is HMAC-chained (G7).** Every control-plane action (actor, reason, affected entity, timestamp) is appended; each row includes `prev_hmac = HMAC(audit_secret, row_{n-1})`. The chain is verified on boot and on `shamu doctor`. A `BEFORE UPDATE OR DELETE` trigger raises so tampering via the DB is caught even before chain verification. `audit_secret` lives in the OS keychain.

### 3. SQLite operational rules (`packages/persistence`)

One SQLite database. **WAL mode** (`PRAGMA journal_mode=WAL`), `PRAGMA busy_timeout=5000`, `PRAGMA synchronous=NORMAL`. Exactly **one writer process** at a time — enforced by a file lock — with many lock-free readers. Queue claim uses `UPDATE ... RETURNING` against a `claimed_by`/`claimed_until` column to prevent double-pickup; every enqueued job carries an `idempotency_key` so re-enqueue is a no-op.

Migrations: schema bootstrap is protected by an advisory lock row to prevent racing runners. Backups are `VACUUM INTO` to a sibling file (WAL-safe) on a nightly cadence; the output is file-copy friendly. Compaction (`PRAGMA wal_checkpoint(TRUNCATE)`) after every VACUUM.

In-memory channels are used only for ephemeral supervisor↔worker heartbeats — not fsync'd, not replayed. They go away with the process.

### 4. Supervisor (`packages/core/supervisor`)

OTP-shaped tree. A `Swarm` supervises `Role` supervisors (`planner`, `executor`, `reviewer`, …); each role supervises workers. Restart policies per role are config-driven; defaults:

- `planner`: `{ intensity: 3 per 60s, strategy: "one_for_one", escalate: "swarm" }`
- `executor`: `{ intensity: 5 per 300s, strategy: "one_for_one", escalate: "role" }`
- `reviewer`: `{ intensity: 2 per 120s, strategy: "one_for_one", escalate: "swarm" }`

**Escalations are local domain events (`EscalationRaised`) — the supervisor never knows about Linear.** Sinks subscribe: the CLI sink surfaces them to stderr/status; the TUI sink drops a toast; the Linear sink (added in Phase 6) flips the issue to `shamu:blocked`. Core stays Linear-agnostic; Phase 3 contains no Linear stubs.

### 5. Mailbox & file leases (`packages/mailbox`)

**SQLite is the canonical store.** Tables:

- `mailbox(msg_id, swarm_id, from_agent, to_agent, body, delivered_at, read_at)`
- `leases(lease_id, swarm_id, agent, holder_run_id, holder_worktree_path, glob, acquired_at, expires_at)`

`from_agent` is **assigned by the orchestrator from the authenticated run context, never accepted from the writer** (G6 from threat model). The mailbox API signature takes no `from` parameter; writes from a caller that doesn't own an active run are rejected server-side. `holder_worktree_path` is captured at lease-acquire time so the stale-lease last-touch check (see Patch lifecycle §1) can run `git status --porcelain` in the holder's worktree — the correct worktree.

Files on disk (`.shamu/mailbox/<agent>.jsonl`) are a **transactional materialized export** for human inspection and for agents whose SDKs can't speak SQLite — updated after each DB write inside the same transaction, reconciled on boot. No dual-write: the DB is authoritative; files are regenerated from it if divergence is detected.

Advisory glob-leases only cover pre-write coordination — they do **not** prevent semantic conflicts (two agents editing independent but semantically-related areas). The **patch lifecycle** (below) owns post-edit reconciliation. The pre-commit guard rejects any commit whose author doesn't hold a live lease covering every staged path.

### 6. Watchdog (`packages/watchdog`)

Runs as a separate Bun subprocess; shares SQLite read-only so a stalled main process can't silence it. Four signals, each producing a typed observation with a **confidence value** — never a raw bool:

1. `checkpoint_lag`: no `checkpoint` event in `max(floor, 3× rolling_median_for_role)`. `confidence="unknown"` until the role has ≥ 10 checkpoints observed. Floor default 20 min.
2. `no_write_activity`: no `tool_call` matching the role's **vendor-aware write-tool allowlist** (`Edit|Write|Bash` for Claude; `apply_patch`/`shell` for Codex; per-adapter) in 15 min, and no `turn_end`.
3. `cost_velocity`: per-run cost > 4× rolling median across that role. `confidence="unknown"` for first N runs per role.
4. `tool_loop`: same `(tool, canonicalized_args_hash)` ≥ 3× consecutively. Canonicalization redacts secrets and normalizes whitespace before hashing.

Alerts require **two observations at confidence ≥ medium** to agree. Single-signal and unknown-confidence trips are logged as `watchdog.hint`, never as escalations. This is the defense against the documented "silence detector" amplification loops.

### 7. Cost accounting (`packages/persistence/cost`)

Cost is **nullable with confidence metadata** because vendor billing models don't agree. The `source` and `confidence` labels are set by the **core** from the adapter's declared `costReporting` capability — never from runtime adapter output. A compromised adapter cannot mis-tag its own cost to evade budgets (T17 from threat model).

- `costReporting: "native"` (Anthropic) → `cost.usd` set from vendor response, `confidence="exact"`, `source="vendor"`.
- `costReporting: "subscription"` (Cursor, Codex [both API-key and ChatGPT-OAuth paths], Amp) → `cost.usd=null`, `confidence="unknown"`, `source="subscription"`. **Codex correction (Phase 2.B):** `@openai/codex-sdk@0.121.0` surfaces only token counts — no `cost_usd` on either auth path — so Codex is declared `subscription`, not `native`. If a future SDK revision exposes dollar cost, flip the manifest to `native` in one line.
- `costReporting: "computed"` (local models, cache-heavy runs) → `cost.usd` computed by core from `tokens × price_table`, `confidence="estimate"`, `source="computed"`.
- `costReporting: "unknown"` → `cost.usd=null`, `confidence="unknown"`, `source="unknown"`.

Rollups surface confidence per aggregate (`"$4.32 exact + $1.10 estimated + 2 subscription runs"`). Budgets and rate limits read from exact+estimated only; subscription runs are tracked for auditability but never block.

### 8. Workflow engine (`packages/core/flow`)

Canonical loop: `plan (GPT-5.4) → execute (Opus 4.7) → review (GPT-5.4) → loop until reviewer approves or max iterations`. Expressed as a typed, serializable DAG (`AgentStep`, `Conditional`, `Loop`, `HumanGate`, `ParallelFanOut`, `Join`) — resumable, inspectable, replayable. LangGraph-style DAG, not AutoGen-style group chat (5–6× cost for comparable accuracy per research).

Flow state persists to `flow_runs(flow_run_id, dag_version, state_json, resumed_from)`. Any flow can resume against its last completed node; node outputs are content-hashed so reruns deduplicate.

### 9. Linear integration (`packages/linear`) — an optional sink

Domain events (`EscalationRaised`, `RunStarted`, `RunCompleted`, `CIRed`, `PatchReady`) are published locally; the Linear package is one subscriber among several. If Linear isn't configured, the core is unaffected.

- OAuth 2.1 DCR against `mcp.linear.app/mcp`; tokens in OS keychain.
- Webhook receiver (Bun HTTP) for `issue-label-added` / `comment-created` / `status-changed`. HMAC signature verification required (constant-time compare). Replay protection via timestamp window (default 5 min) + nonce cache.
- One label = one swarm lane: `shamu:ready`, `shamu:in-progress`, `shamu:review`, `shamu:blocked`.
- One run = one rolling comment + status transitions + PR attachment.
- Rate-limit aware (Linear returns budget headers); back off on 429 and surface as a domain event.

### 10. Quality gate (`packages/ci`)

`packages/ci/gate.ts` spawns `@redwoodjs/agent-ci`, parses its structured output (per Phase 0.D: a `run-state.json` file plus per-step logs under `<workDir>/runs/<runId>/`), and projects failures to `CIRed` / successes to `PatchReady` domain events. No swarm patch is marked "ready" without a green run.

**Gate invariants (from 0.D):**

- `GITHUB_REPO=<owner>/<repo>` is set by the wrapper from the worktree's `origin` remote before spawn — not a user responsibility. Without it, agent-ci crashes at boot.
- Run status is derived from workflow + job statuses, **not** from the top-level `run-state.status` field (agent-ci writes that async fire-and-forget and the process exits before the final flush).
- On interrupt or supervisor shutdown, the wrapper calls agent-ci's own abort command, then reaps any orphaned `agent-ci-<n>` Docker containers as a safety net.
- ANSI SGR codes in step logs are stripped by a conservative regex before passing to the reviewer excerpt.

**Reviewer excerpt is a committed contract, not a handwave.** Deterministic, greedy-then-shrink, token-bounded (default 2000 tokens), TAP-13 and ESLint-aware with a tail-of-log fallback. The reviewer agent's prompt shape depends on it; it lives in `packages/ci` and is covered by fixture tests lifted from the Phase 0.D spike. Vitest/Mocha/Jest native reporters are follow-up extractors added as adapters need them.

Three enforcement layers:

1. **Local**: pre-commit hook consults the lease table and can refuse the commit.
2. **Pre-PR**: the flow engine blocks the reviewer-approve transition on a red `agent-ci` run.
3. **Server-side (GitHub/etc.)**: protected-branch settings require the `agent-ci` status check and signed commits. A local `--no-verify` is moot — the required check simply never posts, so the branch rule blocks the merge.

Reviewer agents receive CI summaries + failure excerpts (not raw logs — token-hungry), must reason about failures, and cannot rubber-stamp. Three consecutive red runs per role trip the watchdog via the `CIRed` domain event.

---

## Security & threat model

The harness runs semi-trusted agent behavior with shell/file/network access, stores API credentials, injects MCP tools, may open webhook receivers, and exposes a local dashboard. Deploy model: **single user, on-device, macOS + Linux first-class, no auth, no CI runtime**. Full threat model in `docs/phase-0/threat-model.md`; this section enumerates the mitigation contracts.

**Credential handling**

- All API keys live in the OS keychain — `security` on macOS, `libsecret`/`Secret Service` on Linux. Never in `.env` committed to the repo, never in the SQLite DB.
- Credential backend abstraction (`packages/shared/credentials`) exposes `get(service, account)` / `set` / `delete`; platform detection in the implementation.
- **Accepted tradeoff:** keychain items are marked "always allow for this app" so autonomous runs aren't prompt-stormed. If shamu itself is compromised, credentials are readable. This is explicit, documented in the onboarding flow, and the right call for a dev-laptop tool.
- Environment variables passed to agent subprocesses are **allowlisted** per adapter config. Default allowlist is `PATH`, `HOME`, `LANG`, `USER`, plus the single vendor-specific key the adapter needs.
- Secrets are redacted from every log sink via a central redactor (regex + exact-value hash list) applied **on first write** to both `raw_events` and `events`. Planted-secret tests are a contract-suite requirement.
- No GitHub-Actions-runtime credential path (env-var fallback): shamu is a dev-laptop tool, not a CI product.

**Per-agent sandbox**

- **Filesystem:** each worker runs in its own git worktree under `.shamu/worktrees/<run-id>/`. The adapter's permission handler rejects absolute paths outside the worktree, `..` escapes, and symlinks that resolve outside, **before the tool call executes** (G4). Pre-commit guard is defense in depth.
- **Network egress broker:** even without containerization, Phases 2–7 enforce an egress allow-list via a local HTTP(S) proxy (mitmproxy-style) that shamu spawns per run and points agent subprocesses at via `HTTPS_PROXY`. The broker consults the run's `allowed_hosts` and surfaces denied destinations as `policy.egress_denied` events (G2). Containerized enforcement in Phase 8 replaces the broker; policy file format is shared.
- **Command execution:** shell tool calls are gated through `PermissionMode` (Phase 2). Patterns are matched against a parsed shell AST (via `shell-quote`), not raw command strings. `$()`, backticks, `eval`, pipes-to-shell, and process substitution are rejected unless explicitly allow-listed (G5). Prefer structured tool APIs over `Bash` for routine operations.
- **Process:** subprocesses inherit the allowlisted env only; CWD is pinned to the worktree; every spawn uses `detached: true` + own process group so `process.kill(-pgid)` reaps stray grandchildren; signals are brokered through the adapter handle.

**MCP trust (G3)**

- In-process MCP tools are trusted (shamu wrote them).
- stdio MCP servers are pinned by package name + integrity hash in the config.
- http MCP servers are pinned by origin + TLS pin in the config.
- A config change introducing a new MCP source requires explicit `shamu mcp trust <fingerprint>` approval; writes an audit event. Webhook or CLI-delivered config cannot silently introduce new MCP sources.

**Webhook hardening**

- HMAC-SHA256 signature verification, constant-time compare.
- Timestamp window (default 5 min) + SQLite-backed nonce cache rejects replays. `shamu doctor` checks clock skew vs NTP.
- Per-source-IP rate limit; log-and-drop above threshold.
- `shamu linear tunnel` provisions a cloudflared route restricted to `/webhooks/linear` **only** (G10). The dashboard port is never exposed through `linear tunnel`. `shamu doctor` warns if any local port other than the webhook port is reachable through an active tunnel.

**Dashboard**

- Binds to `127.0.0.1` by default. `--unsafe-bind` exists as an explicit escape hatch for LAN-accessible setups and prints a banner; even then, **auth is out of scope for v1** (single-user, dev-laptop deploy).
- SSE endpoint rejects `Origin` headers outside the configured allow-list. Default allow-list is `http://127.0.0.1:*`; `--unsafe-bind` requires explicit origin additions, no wildcards.
- No run secrets in query strings or path segments.

**Audit log**

- Every control-plane action is persisted as an `audit_events` row. HMAC-chained (see §2 Event log) — tamper-evident, not merely append-only-by-convention (G7).

**Supply chain (G9)**

- Direct dependencies pinned to exact versions (no `^` or `~` in `package.json`).
- `bun install --frozen-lockfile --ignore-scripts` for production installs; CI runs `bun audit` (or equivalent).
- Vendor SDKs installed behind a per-package allow-list: new transitive dependencies with postinstall scripts fail CI.
- Where available, `provenance` required on direct deps.

---

## Patch lifecycle

The unit of work an executor produces. Sits between the mailbox/lease layer and the CI gate.

1. **Claim.** Executor acquires a lease over a glob before reading/writing. Stale leases (expired) can be reclaimed only after a **last-touch check**: `git status --porcelain --untracked-files=all --ignored=no` scoped to the lease globs, run **in the holder's worktree** (`holder_worktree_path` from the lease row). Any non-empty output refuses reclaim and raises `EscalationRaised`. If the holder's worktree is missing entirely, also refuse — treat as `holder_worktree_missing` and escalate. Never silently grant.
2. **Edit.** Worker edits within its worktree. Only paths under live leases held by this worker are allowed; the adapter permission handler enforces path-scope at dispatch time; pre-commit guard is backup.
3. **Commit.** Signed commit on `shamu/<run-id>`. Message includes `run_id`, `flow_run_id`, `flow_node_id`, `lease_ids`.
4. **CI.** Gate fires `agent-ci`; result attaches to the run (events + artifact rows) via the `packages/ci` parser.
5. **Review.** Reviewer agent receives diff + CI summary + lease metadata. Verdict is `approve` / `revise` / `block`.
6. **Integrate.** On approve + green CI, patch merges into `shamu/integration/<swarm-id>` (non-ff merge for ancestry). **Three complementary checks must all pass**, per Phase 0.C findings:
   - `git merge --no-commit` exit code — catches textual line conflicts.
   - **Diff-overlap check** (`diffOverlapCheck(repo, integrationBranch, windowStart, mergedRuns, policy)`, implemented in `@shamu/core-composition/diff-overlap`) — catches shared-file risk git itself merged cleanly. For each run `{runId, branch, mergeBase, mergedAt}` in `mergedRuns` whose `mergedAt >= windowStart`, runs `git diff --name-only -M <mergeBase>..<branch>` to isolate that run's own contribution, then cross-intersects: files touched by ≥ 2 runs (excluding `ignoredGlobs`) become `sharedFiles`, and files matching `alwaysFlagGlobs` touched by ≥ 1 run become `alwaysFlagged`. `integrationBranch` is asserted to exist and reserved for future `windowStart`-anchoring use. `alwaysFlagGlobs` default `**/*.test.*`, `**/tsconfig*.json`, `package.json`, `**/schema.sql`, `agent-ci.yml`, `.github/workflows/*.yml`; `ignoredGlobs` default `**/*.md`, `node_modules/**`, `vendor/**`, `.shamu/**`; non-empty flagged set fans back to a reconcile node.
   - **Rerun `agent-ci`** on the integration branch after the merge — catches cross-file semantic breaks (e.g., rename in one patch, caller in another).
7. **Auto-revert is bisect-aware, not blind.** If integration CI turns red after a merge, revert the last merge (`git revert -m 1 <merge-sha>`), rerun CI. If still red, the break was latent; bisect backwards up to N attempts before quarantining the whole window. A blind single-revert that assumes the last merge caused the break would hide pre-existing failures.
8. **Human handoff.** Integration branch → human PR against the target branch. Human merges (or closes); Linear attachment updates.

Failure paths: a patch that fails CI after N retries is marked `quarantined`, its branch is preserved, and the flow node fails over to `HumanGate`. Quarantined patches accumulate in a `shamu:quarantine` view and don't block other lanes.

**Implementation note:** the `packages/worktree` implementation must not pass `-q` to `git revert` or `git worktree prune` (rejected by git 2.50+). Redirect stdout/stderr instead.

---

## Adapter acceptance criteria

Every adapter — including the built-ins — must pass the shared contract suite before merging. A "yes" per row means "supported AND covered by a contract test." A "no" means the adapter must **declare** it in `Capabilities`; an undeclared "no" is a contract-suite failure.

| Criterion | Minimum expectation |
|-----------|---------------------|
| `spawn` → working handle | assistant message streams within 30s |
| `resume(sessionId)` warm-start | cache/session metrics observable; turn succeeds |
| `events` async iterable | yields `session_start`, ≥ 1 `assistant_*`, `turn_end` in order |
| `send` multi-turn | follow-up in same session produces correlated `turn_id` |
| `interrupt()` | `interrupt` event published, next `turn_end`/`error` within 10s |
| `setModel` | subsequent `usage` events report new model |
| `setPermissionMode` | `permission_request` events respect new mode |
| `shutdown(reason)` | handle completes, subprocess reaped, no orphans |
| Tool-call visibility | `tool_call` + `tool_result` with matching `toolCallId` |
| Patch metadata | `patch_applied` for every file write (unless `patchVisibility: "filesystem-only"` declared) |
| Usage + cost | `usage` per turn; `cost` with declared confidence |
| Error surfaces | `error` with `fatal` + `retriable` set accurately on forced-fail cases |
| No leaks | 100-run stress: no subprocesses, no DB locks, no orphan worktrees |
| Secret redaction | planted API-key strings in prompts/tool-args appear redacted in `events` |

Capability declarations are schema-validated; the contract suite reads `capabilities` and skips tests the adapter has opted out of — but logs the opt-out so reviewers notice when an adapter declares itself less capable over time.

---

## Phased delivery

**Nine phases (0 through 8).** Each phase ships a usable slice and is gated by its own `agent-ci` green.

Calendar time is deliberately unassigned. The review agent flagged an 8-week timeline as fantasy for a team of humans — that's true and also beside the point: shamu's premise is that an AI swarm does the work and humans review. A swarm dogfooding itself from Phase 3 onward is the point, not a nice-to-have. Phases complete when their exit criteria pass; the `agent-ci` gate plus the acceptance checks are the only speed governor we trust.

**Notation:** Tasks are grouped into **Tracks** within each phase. Tracks labeled "Parallel" can proceed concurrently (no inter-track dependencies). Tracks labeled "Serial" must complete their predecessor first. A ⇢ marker on an individual task means "blocks the next track."

### Phase 0 — De-risking spike (before any contracts freeze)

Time-boxed validation of the assumptions that cost the most if they're wrong. Every task produces a **kill-switch finding** checked into `docs/phase-0/` — a written go/no-go with evidence. Contract edits happen in response to these findings before Phase 1 starts.

**Track 0.A — Bun compatibility (Parallel)** ✅
- [x] Claude Agent SDK under Bun: `spawn`, JSONL streaming, hook bridge; compare event shapes to Node reference
- [x] Codex SDK under Bun: `startThread`/`runStreamed` shape, resume, subprocess reaping under SIGINT/SIGTERM
- [x] SQLite WAL under Bun with 5–10 concurrent readers + 1 writer; measure p50/p99 write latency under realistic event volume
- [x] `bun build --compile` single-binary with SQLite embedded; smoke on macOS arm64 + Linux x86_64
- [x] **Kill-switch:** not triggered — Bun stayed as the default runtime; 200MB Claude CLI sidecar deferred to Phase 8

**Track 0.B — Event schema adequacy (Parallel)** ✅
- [x] Capture raw event streams from Claude and Codex on three canonical tasks (bug fix, refactor, new feature) — stored as fixtures
- [x] Project into the draft normalized schema; record every field that required a new kind or extension
- [x] Lock the `AgentEvent` taxonomy against evidence, not a priori design
- [x] **Kill-switch:** not triggered — 2.6% unmapped (well under 20%); added `reasoning` + `rate_limit` kinds and `vendorCliPath` on `SpawnOpts`

**Track 0.C — Worktree merge mechanics (Parallel)** ✅
- [x] Manufactured conflicts: two agents edit overlapping files in separate worktrees; prove the post-merge diff-overlap check catches it
- [x] Integration-branch rerun-CI loop with induced red patches; verify automatic revert + `CIRed` flow
- [x] Measure cleanup cost and disk footprint with 10 concurrent worktrees
- [x] **Kill-switch:** not triggered — reconcile loop deterministic across all six manufactured scenarios

**Track 0.D — agent-ci integration shape (Parallel)** ✅
- [x] Invoke `agent-ci` against a scratch repo; capture JSON/JUnit output structure
- [x] Decide failure-excerpt extraction heuristic (token-bounded, deterministic)
- [x] Write a replay harness so reviewer-context tests don't need live CI runs
- [x] **Kill-switch:** not triggered — `run-state.json` + step logs parse cleanly; soft RFC for `--report=json` filed as a follow-up, not a blocker

**Track 0.E — Threat model writeup (Parallel with everything)** ✅
- [x] Data-flow diagram: credentials, user prompts, webhook payloads, agent outputs
- [x] Trust boundaries drawn (host ↔ agent, agent ↔ vendor API, local ↔ webhook sender, local ↔ dashboard client)
- [x] Mitigations mapped to the Security & threat model section above; gaps flagged as phase blockers

**Exit:** five writeups under `docs/phase-0/`; adapter contract, event schema, patch lifecycle, CI integration, and threat model edits merged into `PLAN.md` based on findings.

**Status (2026-04-17):** All five spikes complete.

- **0.A Bun compatibility** — GO. Bun throughput/WAL/compile all green; SDK imports clean. Caveats: `ClaudeSDKClient` doesn't exist in `@anthropic-ai/claude-agent-sdk@0.2.113` (use `query()` + `unstable_v2_createSession`); subprocess helper must do Node-style `drain` backpressure; the 200MB Claude CLI can't be `bun build --compile`-bundled (sidecar story for Phase 8).
- **0.B Event schema adequacy** — GO. 2.6% unmapped (3/114 events); well under 20% kill-switch. Both SDKs run under CLI-auth via `vendorCliPath`. Additions: `reasoning` kind (both vendors emit it), `rate_limit` kind (Claude budget signal), `vendorCliPath` on `SpawnOpts`, `summarizeToolResult` helper for Phase 1.C. Cost of the spike: $0.90 on Claude, subscription on Codex.
- **0.C Worktree merge mechanics** — GO. Six manufactured scenarios pass. Three-check reconcile (merge exit code + diff-overlap + rerun CI). Holder-worktree stale-lease check. Bisect-aware revert. git 2.50 rejects `-q` on revert/prune.
- **0.D agent-ci integration shape** — GO. Parser lifts into `packages/ci`. `GITHUB_REPO` invariant, Docker container reaping on interrupt, derive status from workflow+job (top-level `state.status` is fire-and-forget-stale).
- **0.E Threat model** — 17 threats, 11 concrete PLAN gaps, 5 pre-Phase-1 blockers folded in (path-scope at dispatch, mailbox `from_agent` auth, audit HMAC chain, cost source from Capability, supply-chain pinning).

---

### Phase 1 — Foundations

**Track 1.A — Repo bootstrap (Serial, blocks everything else)** ✅
- [x] Init Bun workspace + `turborepo` (or `moonrepo`) topology ⇢
- [x] Wire Biome lint/format, Vitest, TypeScript strict config ⇢
- [x] `.github/workflows/ci.yml` skeleton (lint + typecheck + test) — matrix across macOS + Linux

**Track 1.B — Shared foundations (Parallel, start after 1.A)** ✅
- [x] `packages/shared`: `Logger`, `Result<T,E>` helpers, error taxonomy, branded IDs
- [x] `packages/shared`: Zod schemas for `AgentEvent` (incl. `reasoning` + `rate_limit`), `SpawnOpts`, `Capabilities`, audit events
- [x] `packages/shared/credentials`: cross-platform keychain abstraction (macOS `security`, Linux `libsecret`/`Secret Service`); "always allow this app" flag documented
- [x] `packages/shared/redactor`: central secret redactor (regex + value-hash list); planted-secret test suite
- [x] `packages/persistence`: SQLite schema + migration runner with advisory-lock protection
- [x] `packages/persistence`: tables for `runs`, `sessions`, `events`, `raw_events`, `checkpoints`, `mailbox`, `leases` (incl. `holder_run_id`, `holder_worktree_path`), `linear_issues`, `ci_runs`, `flow_runs`, `audit_events` (HMAC-chained)
- [x] `packages/persistence`: `BEFORE UPDATE OR DELETE` trigger on `audit_events` raising
- [x] `packages/persistence`: typed query helpers (no ORM — prepared statements only)
- [x] No dynamic SQL string building in `packages/persistence` (enforced via a unit test that greps source, not a Biome rule — runs on every CI)

**Track 1.C — Adapter contract (Serial after 1.B shared types)** ✅
- [x] `packages/adapters/base`: `AgentAdapter`, `AgentHandle`, `AgentEvent`, `Capabilities` interfaces + immutable manifest loader
- [x] `packages/adapters/base`: subprocess-with-JSONL helper (`Bun.spawn` + line splitter + **Node-style `drain` backpressure** for writes to vendor stdin; all vendor CLIs are Node-based)
- [x] `packages/adapters/base`: `detached: true` / process-group spawn pattern; `process.kill(-pgid)` reap helpers
- [x] `packages/adapters/base`: path-scope validator (reject absolute paths outside worktree, `..`, resolved-symlink escapes) used by every adapter's permission handler
- [x] `packages/adapters/base`: shell AST gate (`shell-quote`) with reject-list for `$()`, backticks, `eval`, pipes-to-shell, process substitution
- [x] `packages/adapters/base`: `summarizeToolResult(bytes, text): string` shared truncation helper so every adapter produces identical summaries for identical tool outputs (per 0.B finding)
- [x] `packages/adapters/base`: `vendorCliPath` support in `SpawnOpts` + adapter-specific mapping (Claude → `pathToClaudeCodeExecutable`; Codex → CLI override)
- [x] `packages/adapters/base`: normalized event replayer (record/replay for tests) — the 0.B fixtures (`docs/phase-0/event-schema-spike/fixtures/`) are the initial regression baseline (replay uses a temporary normalization shim; regenerate fixtures in Phase 2)
- [x] `packages/adapters/base`: shared contract test suite (will be run by every adapter)

**Track 1.D — CLI shell (Parallel with 1.C, depends on 1.B)** ✅
- [x] `apps/cli`: command framework (citty) with per-command `--json` + `--watch` helpers and a single-exit runner
- [x] `shamu run`, `shamu resume`, `shamu status`, `shamu logs`, `shamu kill`, `shamu attach`, `shamu flow run/status`, `shamu linear tunnel`, `shamu doctor`, `shamu ui` — all scaffolded; `run`/`status`/`logs` wired to real SQLite in 1.E
- [x] Config loader (Zod-validated `shamu.config.ts`) with parse/validate/import error kinds
- [x] Exit-code taxonomy documented + enforced across every command

**Track 1.E — Stub adapter (Serial after 1.C)** ✅
- [x] `packages/adapters/echo`: emits canned events; passes the full contract suite (13/13 scenarios, zero skips)
- [x] End-to-end smoke: `shamu run --adapter echo` → events streamed to stdout + persisted to SQLite; `shamu status` + `shamu logs --json` round-trip the run

**Exit:** ✅ `shamu run --adapter echo` round-trips a scripted session end-to-end; CI green on lint+types+tests+agent-ci across all 6 workspaces.

---

### Phase 2 — Claude + Codex adapters

**Track 2.A — Claude adapter (Parallel)**
- [x] `packages/adapters/claude`: wrap `query()` (returns async-iterable `Query` with `interrupt`/`setModel`/`setPermissionMode`/`rewindFiles`) behind `AgentAdapter`. Phase 0.A verified `ClaudeSDKClient` does **not** exist in `@anthropic-ai/claude-agent-sdk@0.2.113`; use `query()` for one-shot and `unstable_v2_createSession`/`unstable_v2_prompt` for warm-resume.
- [x] Hook bridge: `PreToolUse`/`PostToolUse`/`Stop`/`SessionStart` → normalized events
- [x] In-process MCP server injection for orchestrator-provided tools
- [x] Cache-key composition contract: include `runId` (or per-session salt) in the cache prefix; flush caches when MCP tools or system prompt change; contract test asserts two runs with different system prompts don't share a cache hit (T9 from threat model)
- [x] Claude-specific contract test suite run (13/13)

**Track 2.B — Codex adapter (Parallel with 2.A)**
- [x] `packages/adapters/codex`: wrap `@openai/codex-sdk@0.121.0` `startThread`/`resumeThread`/`runStreamed`
- [x] JSONL event normalization (`item.completed`, `turn.completed`); `turn.started` suppressed (covered by `turnId` in envelope)
- [x] Thread-ID persistence; `CODEX_API_KEY` + ChatGPT-OAuth (`vendorCliPath`) auth paths; `vendorCliPath` takes precedence
- [x] Codex-specific contract test suite run (13/13)

**Track 2.C — Session persistence & cost (Serial, depends on 2.A or 2.B landing)**
- [x] Persist `session_id` ↔ `run_id` mapping into SQLite (`sessionsQueries`)
- [x] `shamu resume <run>` CLI command (wired; shared driver + T17 stamping)
- [x] `usage` + `total_cost_usd` aggregation per run, per role (`aggregateRunCost`/`aggregateRoleCost`)
- [x] Snapshot tests: normalized event stream for each vendor (Claude + Codex both pinned)

**Exit:** single-agent run for both vendors; `shamu resume` produces cache-warm follow-up turns (verified by `cache_read_input_tokens > 0`).

---

### Phase 3 — Supervisor, worktrees, mailbox

Three tracks fully parallel — none depends on the others' internals, only on Phase 1/2 primitives.

**Track 3.A — Supervisor (Parallel)** ✅
- [x] `packages/core/supervisor`: OTP-shaped `Supervisor` type, restart strategies (`one_for_one`, `rest_for_one`)
- [x] Restart-intensity bookkeeping (N restarts per T seconds → escalate)
- [x] Per-role policy config (planner/executor/reviewer defaults)
- [x] Escalation publishes `EscalationRaised` domain event; in-memory subscriber surfaces to CLI/status. No Linear coupling — that sink lands in Phase 6
- [x] Unit tests: simulated worker crashes exercising every restart path

**Track 3.B — Worktrees (Parallel)** ✅
- [x] `packages/worktree`: create/destroy `.shamu/worktrees/<run-id>` (PLAN originally wrote both `.git/worktrees/shamu-<run-id>` and `.shamu/worktrees/<run-id>` interchangeably; locked in the latter per Security & threat model § Filesystem)
- [x] Per-run branch naming convention (`shamu/<run-id>`); detach on cleanup
- [x] GC: prune worktrees whose run row is `completed`/`failed` and older than N hours (default 24h); persistence decoupled via injected `persistenceReadRun` callback
- [x] Lease-aware pre-commit hook installer (placeholder checker-path until the mailbox guard is wired in; installs to `GIT_DIR/shamu-hooks/pre-commit` via per-worktree `core.hooksPath` + `extensions.worktreeConfig` — git 2.50 ignores `GIT_DIR/hooks/` for secondary worktrees)
- [x] **git 2.50 gotcha:** `-q` / `--quiet` banned pre-flight in the `runGit` wrapper for `revert` and `worktree prune` (throws `GitInvariantError`). Applies to every git subcommand invoked from this package.

**Track 3.C — Mailbox & leases (Parallel)** ✅
- [x] `packages/mailbox`: primitives layered on existing `@shamu/persistence` `mailbox` + `leases` tables (canonical store); `.shamu/mailbox/<agent>.jsonl` transactional materialized export with atomic rename + `fsync`; `reconcile(baseDir, db)` regenerates on boot
- [x] `broadcast`, `whisper`, `read`, `markRead` primitives — public signatures accept no `from` parameter; `from_agent` is sourced exclusively from `AuthContext.agent` (G6 is a code-level invariant, not a convention)
- [x] Writes require a present `AuthContext`; `UnauthenticatedWriteError` on an invalid context. Run-liveness validation is the orchestrator's job and deliberately not coupled into this package
- [x] TTL'd advisory leases keyed on glob with `globsOverlap` (segment-walk with `**` backtracking + regex for star segments); `reclaimIfStale` runs `git status --porcelain --untracked-files=all --ignored=no -- <glob>` in the holder's worktree via `execFile` (no shell); non-empty output → `{ reclaimed: false, reason: "dirty_holder" }` + escalation; missing holder worktree → `holder_worktree_missing` + escalation
- [x] Pre-commit guard: `checkStagedPaths` (pure) + `runPreCommitGuard` (shells `git diff --cached --name-only`)
- [x] Contract tests: 52 tests across 7 files (auth / mailbox / leases / reclaim / pre-commit / materialize / globs); `from_agent` forgery rejected at the type level, racing-lease one-wins, stale-lease-with-dirty-holder refuses cleanly

**Track 3.D — Watchdog (Serial after 3.A supervisor + any adapter emitting `checkpoint` events)** ✅
- [x] `packages/watchdog`: out-of-process Bun subprocess (`spawnWatchdogSubprocess` + `entry.ts`), shares SQLite read-only via `openReadOnlyDatabase` (package-local; `@shamu/persistence` untouched)
- [x] Four signals with typed confidence values: `checkpoint_lag`, `no_write_activity`, `cost_velocity`, `tool_loop` — each a pure evaluator plus DB-backed wrapper
- [x] Vendor-aware write-tool allowlist: Claude `Edit|Write|Bash`, Codex `apply_patch|shell`
- [x] Trip rule: `AgreementBuffer` promotes to `watchdog.alert` only when two distinct signals fire at `confidence ≥ medium` within the window; singleton or unknown-confidence trips emit as `watchdog.hint`
- [x] `canonicalize.ts`: whitespace-normalize-before-JSON + `@shamu/shared/redactor` + sorted-key stringify; verified via test that secret-bearing args with different tokens hash identically
- [x] Integration test `manufactured-stall.test.ts`: event stream + simulated clock proves the alert fires inside the expected window AND that a cold-started role (`< 10 checkpoints`) emits `confidence=unknown` with no false escalation
- [x] `runWatchdog` is pure (`now`, `emit`, `state` injected) — no timers in the core; `setInterval`-equivalent loop lives only in `subprocess.ts`/`entry.ts`

**Exit (primitives):** the four packages are published, each unit-tested; supervisor restarts a simulated worker under policy; watchdog fires on a manufactured stall and shows `confidence=unknown` for cold-starts; stale-lease last-touch check is implemented and green; `@shamu/worktree` GC classifies a 10-worktree fixture correctly.

**Deferred to Phase 4 (composition, not a Phase 3 primitive):** two real Claude workers in parallel worktrees coordinate via mailbox end-to-end; the remaining five Phase 0.C manufactured scenarios (clean concurrent, overlapping lines, non-overlapping same-file, cross-file semantic, 10-worktree cleanup cost) reproduced as contract tests against the live flow; diff-overlap check wired into the integrate step of the patch lifecycle. These all require the flow engine to compose primitives; Phase 3 deliberately stops at the primitive layer. **Landed in Phase 4 Track 4.D (`@shamu/core-composition`).**

---

### Phase 4 — Plan → Execute → Review flow

Mostly serial — the flow engine composes earlier primitives.

**Track 4.A — Flow engine (Serial)**
- [x] `packages/core/flow`: typed DAG nodes (`AgentStep`, `Conditional`, `Loop`, `HumanGate`)
- [x] Serializable state (resumable after crash)
- [x] Event stream: per-node progress, per-node cost roll-ups

**Track 4.B — Canonical flow (Serial after 4.A)**
- [x] `flows/plan-execute-review.ts`: GPT-5.4 planner → Opus executor → GPT-5.4 reviewer → loop until approve / max-iterations
- [x] Context passing: planner output → executor input, executor diff → reviewer input
- [x] Approve/revise verdict schema for reviewer

**Track 4.C — CLI + telemetry (Parallel with 4.B)**
- [x] `shamu flow run <name> --task "..."`
- [x] `shamu flow status <flow-run>` — per-node breakdown
- [x] Structured JSON logs per flow-run for later replay

**Track 4.D — Composition exits (Serial after 4.A–4.C; closes Phase 3 deferrals)**
- [x] `EscalationEmitter` shim: `@shamu/mailbox` + `@shamu/watchdog` alerts → `@shamu/core-supervisor` bus (`@shamu/core-composition/escalation-emitter`)
- [x] `persistenceReadRun` driver: `@shamu/worktree` GC reads real run rows via `@shamu/persistence/queries/runs` (`@shamu/core-composition/persistence-read-run`)
- [x] `diffOverlapCheck` helper implementing PLAN § "Patch lifecycle" line 450 (`@shamu/core-composition/diff-overlap`); integrate-step wiring lands with the Phase 5 CI gate
- [x] Two-workers-via-mailbox E2E (two `@shamu/adapter-echo` workers coordinate in parallel worktrees)
- [x] Phase 0.C scenarios 1/2/3/4/6 ported as contract tests (scenario 5 stale-lease landed in Phase 3.C)

**Exit:** flow completes end-to-end on a sample repo; reviewer reject causes a clean executor re-run with prior diff + reviewer notes in context; **Phase 3-deferred composition exits**: two real workers in parallel worktrees coordinate via mailbox, remaining Phase 0.C scenarios reproduced as contract tests against the live flow, diff-overlap check wired into the integrate step of the patch lifecycle.

The live end-to-end (`SHAMU_FLOW_LIVE=1`) smoke against real Claude + Codex CLIs is gated in `packages/flows/plan-execute-review/test/live/smoke.live.test.ts` and is the one manual-test step owed before the phase is considered fully validated.

---

### Phase 5 — agent-ci gate

**Track 5.A — CI wrapper (Parallel). Lifts the Phase 0.D spike parser from `docs/phase-0/agent-ci-spike/parser/` into `packages/ci/`; only the subprocess driver reshapes from Node `child_process.spawn` to `Bun.spawn`.**
- [x] `packages/ci/gate`: spawn `@redwoodjs/agent-ci`; set `GITHUB_REPO` from the worktree's `origin` remote before spawn (boot invariant)
- [x] Run-dir discovery via pre/post diff of `<workDir>/runs/` (agent-ci has no stdout pointer to the run dir)
- [x] Parse `run-state.json` + per-step logs; **derive run status from workflow + job statuses**, never from top-level `state.status` (fire-and-forget save quirk)
- [x] TAP-13 extractor, ESLint-stylish extractor, tail-fallback for unknown formats
- [x] ANSI SGR stripping (conservative regex)
- [x] `toDomainEvent` projection → `CIRed` / `PatchReady`
- [x] Interrupt path: call agent-ci's own abort first, then reap any `agent-ci-<n>` Docker containers as safety net
- [x] Replay tests over the three Phase 0.D fixtures (green, red-test, red-lint) — must produce byte-identical summaries
- [ ] Artifact capture (logs, reports) attached to run row in SQLite — deferred (needs `@shamu/persistence` schema surface; carried as a Phase 5.C / followup)

**Track 5.B — Reviewer integration (Parallel with 5.A)**
- [x] Reviewer excerpt is a committed contract in `packages/ci`: deterministic, token-bounded (2000 default), greedy-then-shrink, TAP/ESLint-aware with tail fallback — lifted from 0.D spike
- [x] Reviewer agent input schema includes CI summary + excerpt; no raw logs
- [x] Reviewer verdict can require "re-run CI after changes" without declaring approval
- [x] Flow engine: reviewer approval blocked on red CI
- [x] Soft RFC filed upstream for `@redwoodjs/agent-ci --report=json` flag (non-blocking) — draft at `docs/phase-5/rfc-report-json.md`; user owns upstream filing

**Track 5.C — Quality bars (Serial after 5.A + 5.B)**
- [x] Per-role CI-failure counter; watchdog tripwire on three consecutive reds (`@shamu/watchdog/ci-tripwire` — factory + `WatchdogCiTripwire` event; caller wiring in `@shamu/core-composition` is a followup)
- [x] `agent-ci.yml` for this repo — required on all shamu PRs (workflow at `.github/workflows/ci.yml` already in place; Phase 5.C SHA-pinned the third-party actions and added a header documenting the required-check name is load-bearing for the branch-protection script)
- [x] GitHub branch protection on `main` + `shamu/integration/*`: required `agent-ci` status check, signed-commit requirement, linear-history requirement. A local `--no-verify` simply leaves the required status missing — the rule does the work. (Delivered as `scripts/setup-branch-protection.sh` with `--dry-run`; user owns the live-repo API call.)

**Exit:** swarm run cannot mark a patch "approved" without green `agent-ci`; shamu's own repo enforces the same gate on itself.

---

### Phase 6 — Linear integration

**Track 6.A — Auth + client (Serial)**
- [x] Personal-API-key auth against Linear's GraphQL API (`api.linear.app/graphql`); env-first with `@shamu/shared/credentials` persist-back (Keychain / libsecret). (Pivoted from OAuth 2.1 DCR at kickoff — see note below.)
- [x] Typed GraphQL client wrapper for the issue / label / comment / status operations the canonical flow uses (`@shamu/linear-client`)

> **6.A architecture note (2026-04-18):** PLAN originally scoped OAuth 2.1 DCR against the `mcp.linear.app/mcp` MCP server. The user provided a personal API key at kickoff, and GraphQL is a strict subset of what Phase 6 needs (issue read / label + comment + status mutations). OAuth DCR is deferred as a Phase 6 followup in HANDOFF.md — revisit if/when shamu is hosted multi-tenant. The credential-store coordinates (`LINEAR_CREDENTIAL_SERVICE` / `LINEAR_CREDENTIAL_ACCOUNT`) are exported so a future OAuth adapter can reuse or sibling them without migration.

**Track 6.B — Webhook receiver (Parallel with 6.A)**
- [x] `packages/linear/webhook`: Bun HTTP server; HMAC-SHA256 signature verification + ±5-min timestamp window + 10-min nonce-LRU replay protection (`@shamu/linear-webhook`)
- [x] Helper: `shamu linear tunnel` wraps cloudflared; receiver 404s every path other than `/webhooks/linear` (G10 scope enforcement)
- [x] Subscriptions: `issue-label-added`, `comment-created`, `status-changed` (typed discriminated union; other event types accepted with 202 so Linear stops retrying, but not surfaced to consumers)

**Track 6.C — Work-intake conventions (Serial after 6.A + 6.B)**
- [x] Label conventions: `shamu:ready` → picked up; `shamu:in-progress` → working; `shamu:review` → awaiting human; `shamu:blocked` → escalated (landed as `createLabelStateMachine` in `@shamu/linear-integration`)
- [x] Rolling-comment updater: one comment per run, edited in place with checkpoint appends (landed as `createRollingComment`)
- [x] PR link as Linear attachment on completion (landed as `attachPrToIssue` + `shamu linear attach-pr` CLI; auto-attach-from-flow is a deferred followup — see 6.C.3 note below)
- [x] Escalation path: watchdog-trip → status flip to `shamu:blocked` + comment with incident summary (landed as `createEscalationSink` + `createCiTripwire`/`createCiTripwireObserver` wiring via `@shamu/core-composition`; `EscalationCause` union extended with `"watchdog_agreement" | "lease_reclaim_refused" | "ci_tripwire"`)

> **6.C.3 composition note (2026-04-18):** The daemon (`shamu linear serve`) wires every 6.C primitive into a running process — webhook server + pickup driver + escalation sink + per-pickup flow run + rolling-comment bridge + per-run CI tripwire. Composition lives in `apps/cli/` (services/linear-runtime.ts); `@shamu/linear-integration` stays primitive-only. `runFlowInProcess` was extracted from `shamu flow run` so the daemon reuses the engine in-process (no subprocess fork per pickup). Auto-attach of PR URLs on `PatchReady` is deferred because the canonical flow doesn't surface a PR URL in its node outputs today; 6.D uses `shamu linear attach-pr` manually.

**Track 6.D — Integration test (Serial after 6.C)**
- [ ] E2E against a throwaway Linear workspace: label → pickup → PR → status flip

**Exit:** a Linear issue with `shamu:ready` gets picked up, worked, and ends with a PR link + status flip, entirely webhook-driven.

---

### Phase 7 — Adapter fan-out + web dashboard

Biggest parallel fan of any phase. Six adapter tracks plus one web-dashboard track, all independent. Each lands individually once its contract suite is green.

**Tracks 7.A–7.F — Adapters (all Parallel)**
- [ ] 7.A — `packages/adapters/opencode` on `@opencode-ai/sdk` (SSE event mapping; BYO provider keys via `client.auth.set`)
- [ ] 7.B — `packages/adapters/pi` on `@mariozechner/pi-coding-agent` (`runRpcMode` + event subscribe)
- [ ] 7.C — `packages/adapters/cursor` (REST + webhook; async job handles; no streaming; poll fallback)
- [ ] 7.D — `packages/adapters/gemini` on `@google/gemini-cli-sdk`
- [ ] 7.E — `packages/adapters/amp` shelling out to `amp -x --stream-json`
- [ ] 7.F — `packages/adapters/kimi`: OpenAI-compat chat + our own tool loop (fallback template)

**Track 7.G — Capability matrix (Serial after 7.A–7.F)**
- [ ] Generate capability matrix from each adapter's `Capabilities` declaration
- [ ] Contract suite runs against all six on every PR (parallel matrix job in CI)
- [ ] Docs page: "Which adapter supports what"

**Track 7.H — Web dashboard (Parallel with 7.A–7.F; see UI plan task breakdown above)**
- [ ] All web-dashboard tasks from the UI plan land here

**Track 7.I — Network egress broker (Parallel; must land by end of Phase 7)**
- [ ] `packages/egress-broker`: local HTTP(S) proxy (mitmproxy-style) spawned per run; agent subprocesses get `HTTPS_PROXY`/`HTTP_PROXY` pointed at it
- [ ] Per-run `allowed_hosts` policy; denied destinations surface as `policy.egress_denied` events
- [ ] Default allow-lists shipped per adapter (Anthropic → `api.anthropic.com`; Codex → `api.openai.com`; etc.)
- [ ] Contract test: prompt injection attempting `curl attacker.com` is blocked and logged
- [ ] Policy file format shared with Phase 8's containerized enforcement

**Exit:** integration test spawns one of each adapter against the same trivial task; capability matrix published; web dashboard reaches feature parity with the TUI for read-only views.

---

### Phase 8 — Autonomous mode + A2A + ops polish

Crosses the CLI-process → long-lived-service line. **A2A is v1 scope** (confirmed 2026-04-18); autonomous loop is the headline; both tracks gate on the autonomous-daemon go-live.

**Track 8.A — Autonomous loop (Parallel)**
- [ ] Daemon mode: long-lived process subscribed to Linear webhooks, picks up `shamu:ready` issues, runs canonical flow
- [ ] Rate limiter: global concurrency cap + per-role cap; queue overflow → `shamu:blocked` with reason
- [ ] Graceful shutdown: drain running runs into a resumable state before exit
- [ ] 24-hour soak test on staging Linear project

**Track 8.B — A2A server (Parallel with 8.A; v1 scope)**
- [ ] `packages/protocol/a2a`: A2A v1.0 server + client
- [ ] Signed Agent Cards: card signing, card verification on inbound
- [ ] JSON-RPC + SSE transport
- [ ] Auth: bearer tokens bound to Agent Card issuer
- [ ] Example: remote Claude agent hosted on another box joins a local swarm

**Track 8.C — Ops polish (Serial after 8.A; subsumes the UI plan's Phase 8 items)**
- [ ] `shamu doctor`: environment/auth/webhook health check, keychain integrity, clock-skew vs NTP, `audit_events` chain verification, egress-broker reachability, tunnel scope warnings
- [ ] `bun build --compile` single-binary release on macOS arm64 + Linux x86_64
- [ ] **Sidecar bootstrap for the Claude 200MB per-platform binary** (Phase 0.A found it can't be `--compile`-bundled): first-run downloads or ships alongside the main binary; version pinned in config
- [ ] `shamu ui` opens the web dashboard in the default browser
- [ ] Screenshot CI: every PR gets TUI + web screenshots captured via headless render
- [ ] README, architecture diagram, contribution guide, threat-model summary
- [ ] Container-based network egress enforcement replaces Phase 7's in-process egress broker (same policy format)

**Exit:** 24-hour autonomous run on staging Linear with watchdog + escalation proven; signed single-binary release shipped.

---

## Parallelization summary

| Phase | Max parallel tracks | Critical path |
|-------|---------------------|---------------|
| 0 | 5 | All spikes in parallel; writeups are the gate |
| 1 | 2 (after bootstrap) | Bootstrap → Adapter contract → Stub adapter |
| 2 | 2 | Either adapter → session/cost layer |
| 3 | 3 | Any track → watchdog integration |
| 4 | 2 | Flow engine → canonical flow |
| 5 | 2 | CI wrapper + reviewer integration → quality bars |
| 6 | 2 | Auth + webhooks → conventions → E2E |
| 7 | **7** | Adapter fan-out + web dashboard → capability matrix |
| 8 | 2 | Autonomous loop → ops polish |

Phases 0, 3, and 7 are the biggest parallelization wins — up to 5, 3, and 7 concurrent workstreams respectively. Once the shamu swarm is dogfooding itself (Phase 3 onward), those tracks are natural assignments for parallel agent workers: one Claude executor per track, supervised. Phase 7's seven-wide fan-out is what takes the overall calendar time from "months" to "days, if the swarm holds together."

## Quality bars (enforced by CI, not etiquette)

- Biome lint + format on every PR.
- `tsc --noEmit` with `strict: true`, `noUncheckedIndexedAccess: true`.
- Vitest coverage ≥ 80% on `packages/core`, `packages/adapters/base`, `packages/watchdog`, `packages/mailbox`.
- Contract tests per adapter (shared suite, each adapter must pass).
- `agent-ci` green on every PR. Enforced by GitHub branch protection + required status check + signed commits. A local `--no-verify` is irrelevant — the required check simply never posts, so the branch rule blocks the merge.
- Snapshot tests on the normalized event stream so a vendor SDK change can't silently corrupt it.

## Decisions captured from user (2026-04-17)

- **Deploy target:** macOS + Linux, both first-class. Credential backend supports `security` (macOS) and `libsecret` (Linux).
- **Corporate proxy / `HTTPS_PROXY` chain-through:** deferred; design keeps the door open via the Phase 7 egress broker but no work planned now.
- **Team mode / OIDC:** **out of scope**. On-device, single-user, no auth. Stripped from UI plan.
- **GitHub Actions runtime:** never. Always dev-laptop; no env-var credential fallback needed.
- **raw_events retention:** 14-day default accepted.
- **Keychain UX:** "always allow this app" is the default — non-annoying for autonomous runs. Tradeoff (keychain readable if shamu itself is compromised) documented.
- **Autonomy ceiling:** **full autonomy is the design goal**, not an eventual option. Consequences: G2 (egress broker), G3 (MCP trust), G4 (path-scope at dispatch), G6 (mailbox authentication), G7 (audit HMAC chain), and G11 (A2A trust roots) must all be green before the autonomous daemon goes live. Promoted out of "Phase 8 nice-to-have" into concrete phase blockers.
- **Licensing:** MIT (decided during Phase 1 bootstrap; reflected in root `package.json`).
- **Naming:** `shamu` stays (confirmed at Phase 3 kickoff, 2026-04-17).
- **A2A in v1 (confirmed 2026-04-18):** must-ship. Phase 8 Track 8.B is no longer optional. Consequence: G11 (A2A trust roots — Signed Agent Cards, card issuer bearer-token binding, JSON-RPC + SSE transport hardening) is a concrete autonomous-daemon go-live blocker alongside G2/G3/G4/G6/G7. The attack-surface concern noted earlier is managed by the threat-model controls, not by deferring the feature.

## Remaining open questions

None blocking. (Historical: A2A-in-v1 answered 2026-04-18; `vendorCliPath` Phase-0.B resolved earlier.)

## Immediate next step

Phase 0 is 4/5 complete; 0.B awaits keys. Findings folded into PLAN.md. Ready to start Phase 1 scaffolding (Bun monorepo, SQLite schema with WAL + event log tables + HMAC-chained audit table, cross-platform credential backend, adapter base contract with path-scope/shell-AST/Node-backpressure helpers, stub adapter, CLI skeleton, `agent-ci.yml`) as soon as you approve.
