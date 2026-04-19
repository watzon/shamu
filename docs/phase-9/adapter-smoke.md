# Phase 9.B adapter-smoke triage digest

**Track:** 9.B.7 — consolidate every Phase 9.B smoke into a single
full-matrix readout, extract cross-cutting followups, and sync any
declared-vs-actual drift back into the capability matrix.

**Last updated:** 2026-04-19. Branch: `shamu/phase/9b7-triage-digest`.

This document is a digest *of* the per-adapter fragments under
`docs/phase-9/smoke-*.md`. Those fragments remain the source of truth
for per-adapter evidence, defects surfaced, and fixes landed. The
digest's job is the cross-cutting view.

## TL;DR — adapter matrix

| Adapter | Outcome | Evidence | Fragment | Deferred followups | Defects fixed |
| --- | --- | --- | --- | --- | --- |
| claude   | not tracked in 9.B   | Claude was already driven end-to-end through `shamu run` / `shamu linear serve` prior to Phase 9.A (autonomous-daemon soak harness, screenshot CI's render-pipeline stub, every pre-9.A integration path). The 9.A shared resolver now picks up `/Users/watzon/.local/bin/claude` via the `candidate` kind and the sidecar-bootstrap is a last-resort resolver hook; a dedicated 9.B track was not scoped for Claude.                                                                                                                                    | —                                                        | — | — |
| codex    | pass-with-fixes      | `ChatGPT-OAuth` (Path A) turn: `session_start → assistant_message("pong") → usage → cost → turn_end(stopReason=completed)`, exit 0, ~6–9s against `gpt-5-codex`. Non-git cwd regression guard now in place. `CODEX_API_KEY` (Path B) covered by `test/unit/auth.test.ts` (7 tests) with injected env; end-to-end defer-listed (no key on test machine).                                                                                                                                                                                              | [`smoke-codex.md`](./smoke-codex.md)                     | 3 | 2 |
| opencode | pass-with-fixes      | `shamu run --adapter opencode --task "hello"` emits `run-started → session_start → assistant_* → turn_end → run-cost` via the SSE-HTTP transport under a real Anthropic `client.auth.set` API-mode key. Sentinel-based live regression lock proves the user-echo bug is gone. 40/40 unit tests, 2/2 live.                                                                                                                                                                                                                                          | [`smoke-opencode.md`](./smoke-opencode.md)               | 4 | 2 |
| cursor   | pass-with-fixes      | `cursor-agent acp` (`2026.04.17-479fd04`) spawns via the 9.A resolver's `homeRelative` candidate, round-trips `initialize → session/new → session/prompt`, streams `assistant_delta + reasoning + tool_call(Read File) + tool_result + usage + cost + turn_end`. Exit 0. Subprocess reaped cleanly on `shutdown()`.                                                                                                                                                                                                                                 | [`smoke-cursor.md`](./smoke-cursor.md)                   | 5 | 2 |
| gemini   | blocked-on-vendor    | User's Google account is currently ToS-disabled; `gemini --acp` cannot open a session against the Google backend. 9.A resolver resolves `/opt/homebrew/bin/gemini` cleanly, and 58 non-live unit + contract tests pass across 5 suites. Live turn, tool permissions, `session/request_permission`, and gemini-cli#22647 live confirmation are all gated on the appeal.                                                                                                                                                                             | [`smoke-gemini.md`](./smoke-gemini.md)                   | 5 (what-would-be-tested) | 0 |
| amp      | blocked-on-vendor    | Sourcegraph's Amp CLI refuses `amp -x` until the account has paid credits; the test workstation does not have a credited account. 9.A resolver resolves `/Users/watzon/.local/bin/amp` cleanly; 64/1-skip/0 non-live tests pass across 5 files. Live stream-JSON-shell turn, stdin-shape confirmation, per-frame projection, and live cost-source stamping all gated on credits.                                                                                                                                                                   | [`smoke-amp.md`](./smoke-amp.md)                         | 5 (what-would-be-tested) | 0 |
| pi       | pass-with-fixes      | Default-session + `--no-session` flavors both PASS against Pi `0.67.68`. Events: `session_start → assistant_delta → assistant_message → usage → cost → turn_end`, exit 0. Opt-out assertion diffs the `~/.pi/agent/sessions/<slug>/` discovery dir before/after and confirms no on-disk session is persisted.                                                                                                                                                                                                                                      | [`smoke-pi.md`](./smoke-pi.md)                           | 6 | 2 |

Claude's row is included for completeness. The six 9.B tracks covered
the remaining six adapters.

## Status by outcome bucket

- **success (0 adapters).** No adapter landed a 9.B smoke with zero
  defects surfaced; the closest is Claude (no 9.B track — already proven
  end-to-end in prior phases and confirmed through the 9.A resolver on
  this machine).
- **pass-with-fixes (4 adapters).** codex, opencode, cursor, pi — each
  proved a live turn end-to-end after landing one or more adapter fixes
  scoped to a single PR.
- **partial (0 adapters).** No adapter finished the track with a
  partially-observed happy path; every "pass-with-fixes" row ran the
  happy path to `turn_end` and exit 0.
- **blocked-on-env (0 adapters).** Codex's `CODEX_API_KEY` Path B is
  the closest, but the fragment itself shipped as `pass-with-fixes`
  because Path A (ChatGPT-OAuth) was proven live end-to-end and Path B
  is unit-proven with injected env. The Path B end-to-end defer stays
  on the Codex followup list, not as a bucket-level outcome.
- **blocked-on-vendor (2 adapters).** gemini (Google ToS appeal
  pending), amp (paid-credits provisioning pending). Both fragments
  ship as stubs with "what would be tested when unblocked" + the 9.A
  resolver confirmation + non-live test roll-ups so the digest captures
  the full matrix.

## Cross-cutting themes

These are patterns the six fragments share. Each one is a hoist
candidate — a followup that would benefit more than one adapter if
landed as a shared-base change rather than six parallel per-adapter
fixes.

### T1. Env-gated `vitest.live.config.ts` toggle — hoist candidate

9.B.2 (OpenCode), 9.B.3 (Cursor), 9.B.6 (Pi) each shipped a
sibling `vitest.live.config.ts` + `test/live/**` exclude flip keyed
off `SHAMU_<VENDOR>_LIVE=1`. 9.B.1 (Codex) landed the same shape as a
conditional `exclude` inside the existing `vitest.config.ts`. Gemini
and Amp will inherit the pattern once unblocked. The shape is
duplicated verbatim across fragments and cross-referenced in the
Cursor and Pi fragments as a "follow-up to hoist."

**Hoist target:** a shared helper (e.g., `packages/adapters/base/
vitest.live.ts`) that each adapter's `vitest.live.config.ts` imports +
re-exports, plus a contract-test assertion that every adapter package
exposes both a `test` and `test:live` entry point. Cross-adapter.

### T2. ACP-adapter live suites need `bun test`, not `bun x vitest`

Vitest runs its test files under a Node worker even when launched as
`bun x vitest`; inside that worker `typeof Bun === "undefined"`.
`@shamu/protocol-acp`'s `createStdioTransport` uses `Bun.spawn` as the
production spawn path, so every ACP-based adapter's live suite must
run under Bun directly to exercise the real subprocess path. Today
that constraint is split across fragments:

- 9.B.3 (Cursor) calls it out explicitly in the Cursor fragment's
  "Non-defect: live test must run under Bun, not vitest+Node"
  section; the live-suite docstring was updated to say so.
- 9.B.6 (Pi) hit the same wall in a different form — Pi's
  `defaultWhichImpl` + `defaultSpawnImpl` were Bun-only and
  hard-failed under Node; the fix was to add Node-compatible fallbacks
  so the existing `bun x vitest` live entry point works. Cursor's fix
  was documentation; Pi's fix was code.

**Hoist target:** either a shared live-smoke runner script
(`scripts/live-smoke.ts`) that invokes each adapter's live file via
`bun test` (not vitest) with the right `SHAMU_<VENDOR>_LIVE` env, or a
contract-test that every adapter's live suite is runnable under Bun
directly. Affects Cursor, Gemini, Amp, Pi (and any future ACP or
Bun-only adapter). Cross-adapter.

### T3. Usage + cost are zeroed on several subscription-model adapters

Capability-matrix drift opportunity. The six smokes that emitted live
`usage` / `cost` events split cleanly into two groups:

- **Tokens populated** — Codex (via OpenAI's `token_usage` on
  `turn_end`), OpenCode (via `usage` envelope on the SSE stream).
- **Tokens zeroed** — Cursor (ACP server doesn't populate
  `usage.inputTokens` / `outputTokens` in `session/prompt` result);
  Amp (subscription, no per-turn USD); Pi (open 7.E followup: real
  `get_session_stats` wiring not yet implemented).

The `capabilities.json` manifest for every subscription-model adapter
declares `usageReporting: "per-turn"` and `costReporting:
"subscription"`. That declaration is technically accurate — the
adapter emits a `usage` event per turn and a `cost` event stamped as
`source: "subscription"` — but does not distinguish "per-turn with
populated token counts" from "per-turn with zeros because the vendor
doesn't publish them." The capability-matrix drift note below
captures this.

**Hoist target:** either tighten the capability vocabulary (e.g., a
`usageReporting: "per-turn-empty"` subvariant), or let the matrix stay
at the declaration layer and keep the drift as an observation
appendix. For 9.B.7 we take the second path — see the capability-
matrix update below.

### T4. Subprocess CLI tests share `.shamu/state/` DB

Pre-existing followup (PR #32, HANDOFF "From PR #32"). Multiple
subprocess-invoking tests write to a workspace-scoped
`.shamu/state/<worktree-slug>.db`. When an earlier run leaves rows
behind, status-empty assertions flake. None of the 9.B fragments
regressed further on this; Pi's fragment deliberately spawns into
`/tmp` cwds to sidestep the DB collision, and Codex's non-git cwd
regression test uses a fresh tmpdir per run. Keep the original PR #32
item on the followups list; no new Phase 9 track needed.

### T5. Capability-matrix declared-vs-actual deltas

Synthesized from the six fragments (and the Claude row for
completeness). Details in the matrix appendix below.

- **cursor** declares `usageReporting: "per-turn"`; live smoke observed
  `in=0, out=0` on every `usage` event (Cursor ACP server does not
  populate input/output tokens).
- **pi** same declaration; live smoke observed `in=0, out=0` (open
  7.E item: `get_session_stats` not yet wired into `turn_end`).
- **amp** same declaration; would-be-tested when credits land (blocked).
- **opencode** declaration holds on live smoke (tokens populated).
- **codex** declaration holds on live smoke (tokens populated via
  SDK `usage` stamp).
- **cursor** declares `costReporting: "subscription"`; the smoke
  observed `cost usd=null confidence=unknown source=subscription` —
  declaration holds (subscription-model adapters correctly emit
  `usd=null`). Same for pi, amp, gemini, opencode.
- **claude** is `costReporting: "native"`; no 9.B smoke — declaration
  inherits trust from Phase 6–8 drivenness.

All non-usage-token declarations (`resume`, `fork`, `interrupt`,
`customTools`, `patchVisibility`, `patchEvents`, `streamingEvents`,
`permissionModes`, `mcp`, `sandboxing`) held on every fragment where
they were exercised. The only real drift is the input/output token
zeros under `usageReporting: "per-turn"`, and that drift is the same
shape on every subscription-model adapter that doesn't publish live
token counters. See the capability-matrix update below.

## Per-adapter followups

Each item tagged with `[vendor-blocker]`, `[needs-auth]`,
`[followup-track]`, `[cross-adapter]`, or `[pre-existing]` so the
orchestrator can route into HANDOFF.md the right section.

### codex ([`smoke-codex.md`](./smoke-codex.md))

- **D3 — Path B (`CODEX_API_KEY`) live smoke.** End-to-end turn under
  `CODEX_API_KEY` auth, no key on this machine. Unit-proven via
  injected env; live run deferred to a session with the key.
  `[needs-auth]`
- **Stderr surface.** SDK's `CodexExec.run()` discards stderr on
  zero-exit empty-stream paths. A richer diag path (stderr → stdout
  AgentEvents, or a broker seam / `stderrHook`) would give operators
  context on why a CLI refused. `[followup-track]`
- **`approvalPolicy` / `sandboxMode` plumbing.** Current wiring maps
  `permissionMode` to `approvalPolicy: "on-request"`/`"never"` +
  `sandboxMode: "workspace-write"`. Codex CLI supports
  `sandboxMode: "danger-full-access"`, `"read-only"` that the adapter
  does not surface. Defer until supervisor permission model grows.
  `[followup-track]`

(D4 is intended behaviour and explicitly NOT a defect — see fragment
for rationale.)

### opencode ([`smoke-opencode.md`](./smoke-opencode.md))

- **Anthropic OAuth path unexercised.** `applyOpencodeAuth` only
  covers `type: "api"`; the Anthropic OAuth-via-CLI path
  (`type: "oauth"` on OpenCode's wire) is not tested. `[needs-auth]`
- **`vendorOpts.modelID` precedence on usage stamps.** When `--model`
  is unset, `usage.model` ignores `vendorOpts.modelID`. Either honor
  it or drop the field. `[followup-track]`
- **Descriptor candidate for `~/.opencode/bin`.** Some installers drop
  the binary there; today the resolver falls through to `pathLookup`
  (works if on `PATH`). Tightening with a `homeRelative` candidate
  would close the gap. `[followup-track]`
- **Contract-suite user-echo probe.** Hoist the sentinel-based
  regression lock (`SHAMU_BROMIUM_SENTINEL_9B2`) into
  `@shamu/adapters-base/contract-tests` so every adapter is forced to
  prove "user-echo must not project as assistant." `[cross-adapter]`

### cursor ([`smoke-cursor.md`](./smoke-cursor.md))

- **`SHAMU_<VENDOR>_LIVE=1` config pattern across ACP adapters.**
  Gemini, Amp, Pi (+ OpenCode) all share the same unconditional
  `test/live/**` exclude shape. Hoist into a shared helper — this is
  theme T1 above. `[cross-adapter]`
- **Live suite under Bun, not Node-vitest.** Cross-adapter — theme
  T2 above. `[cross-adapter]`
- **Usage counters are zeros.** `in=0 out=0` on every Cursor `usage`
  event. Vendor-side (Cursor ACP server doesn't populate input/output
  tokens in `session/prompt` result). Followup is either a
  vendor-issue request or an adapter-side derivation from character
  counts. `[vendor-blocker]`
- **`tool_result.bytes=0`** on Read-File tool-use. Payload landed in a
  `tool_call_update` where `extractToolSummary` didn't find a
  populated field. Single-line projector fix; hoisted to a
  cross-adapter tool-result-summary review. `[cross-adapter]`
- **Model surface.** Cursor stamps `cursor-default` on every `usage`
  event; if/when the vendor exposes mid-session model switch, wire
  `Capabilities.setModel` and a projector branch for
  `current_mode_update`'s model field. `[vendor-blocker]`

### gemini ([`smoke-gemini.md`](./smoke-gemini.md))

All items below are gated on the Google-account ToS appeal. The 9.A
resolver already resolves `/opt/homebrew/bin/gemini` cleanly without
any Google auth state.

- **Live turn via `gemini --acp`.** `shamu run --adapter gemini --task
  "print hello world"`; full event envelope capture + exit-code.
  `[vendor-blocker]`
- **Streaming `session/update` notifications.** Projector unit-tested;
  first live-stream confirmation deferred. `[vendor-blocker]`
- **`session/request_permission` round-trip.** G4 path-scope + G5
  shell-AST gate live confirmation; fatal-error mapping verification.
  `[vendor-blocker]`
- **gemini-cli#22647** (non-ACP writes bleeding into JSON-RPC stdout).
  Unit-proven via `AcpProtocolError → error(code: "acp_protocol",
  fatal: false)` mapping; live confirmation that the handle stays up
  on each malformed frame. `[vendor-blocker]`
- **Model precedence.** CLI `--model` > `shamu.config.ts`
  `defaultModel` > adapter default. Exercise the full 9.A
  flag → config → adapter-default chain end-to-end. `[vendor-blocker]`

### amp ([`smoke-amp.md`](./smoke-amp.md))

All items below are gated on paid Amp credits. The 9.A resolver
already resolves `/Users/watzon/.local/bin/amp` cleanly.

- **Live turn via `amp -x`.** Full stream-JSON-shell conversation;
  `send → stdin JSONL write → stdout NDJSON parse` loop end-to-end.
  `[vendor-blocker]`
- **`formatUserTurn()` stdin shape on a live dev machine.** Picks up
  the outstanding 7.D follow-up (HANDOFF line 201). `[vendor-blocker]`
- **Streaming JSON projection.** Every live frame type
  (assistant / tool_use / tool_result / usage / error / final) mapped
  into canonical `AgentEvent` kinds. `[vendor-blocker]`
- **Model precedence.** `--model` flag > `adapters.amp.defaultModel` >
  adapter default. `[vendor-blocker]`
- **Cost reporting accuracy.** Confirm `confidence: "unknown"` +
  `source: "subscription"` on first live `usage`. `[vendor-blocker]`

### pi ([`smoke-pi.md`](./smoke-pi.md))

- **CLI has no `vendorOpts` surface.** `shamu run` / `resume` expose
  `--<vendor>-cli` and `--model`, but not
  `vendorOpts.ephemeralSession` / `vendorOpts.providerID` /
  `vendorOpts.modelID`. Pi's adapter reads `--provider` / `--model`
  from `vendorOpts.providerID` / `vendorOpts.modelID`, not from the
  generic `SpawnOpts.model`. Correct scoping: a 9.C-adjacent track
  that lands a generic `--vendor-opt key=value` surface (or typed
  per-adapter flag set) AND wires `--model` into each adapter's
  native model field. `[followup-track]` `[cross-adapter]`
- **Usage + cost are zeroed.** `turn_end` → `usage in=0 out=0` +
  `cost usd=null confidence=unknown source=subscription`. Open 7.E
  followup: real usage + cost via `get_session_stats` on Pi
  `turn_end`. `[pre-existing]`
- **`@shamu/shared/credentials` integration for `resolvePiAuth`.**
  Still stubbed. Pi auth flows through its own on-disk store. Follow-
  on track. `[pre-existing]`
- **`tool_execution_update` progress → `stdout` events.** Not
  observed in these smokes (plain "say hello" triggered no tools).
  Followup from 7.E remains open. `[pre-existing]`
- **`test:live` npm script on `packages/adapters/pi`.** Today the
  only live-smoke entry is `bun x vitest run --config
  ./vitest.live.config.ts`. A sibling script would save operators a
  long command line. Matches the other adapters' state. `[cross-adapter]`
- **Pi's cwd-scoped session copy under `--no-session` is vendor-side.**
  Pi 0.67.68 drops a full session-shaped JSONL into the subprocess cwd
  even with `--no-session` set. Discovery dir
  (`~/.pi/agent/sessions/<slug>/`) opt-out still works. Adapter-side
  mitigation is racy (wipe on shutdown) or unsupported (`--session-dir
  /dev/null`). Upstream issue + out-of-scope for single-PR fix.
  `[vendor-blocker]`

## Orchestrator action items

Copy-paste-ready list for HANDOFF.md folding. Each item routes to the
most-specific fragment + tag.

- **Hoist env-gated `vitest.live.config.ts` into shared helper** so
  every adapter flips `SHAMU_<VENDOR>_LIVE=1` uniformly (theme T1;
  cursor + pi + opencode fragments cross-reference). `[cross-adapter]`
- **Live-smoke runner under Bun** (`scripts/live-smoke.ts` or per-
  adapter `test:live` npm script) so ACP adapters don't have to route
  through `bun x vitest`'s Node worker (theme T2).
  `[cross-adapter]`
- **Generic `--vendor-opt key=value` CLI surface + `--model` → each
  adapter's native model field.** Pi's `vendorOpts.providerID /
  modelID`, Codex's sandbox-mode plumbing, OpenCode's
  `vendorOpts.modelID`, and any future adapter-specific knob need a
  uniform CLI entry. `[followup-track]` `[cross-adapter]`
- **Contract-suite user-echo probe.** Hoist 9.B.2's sentinel-based
  regression lock into `@shamu/adapters-base/contract-tests`.
  `[cross-adapter]`
- **Tool-result-summary extraction review across adapters.** Cursor's
  `tool_result.bytes=0` on Read-File tool-use is a projector-side
  single-line fix; audit every adapter's `extractToolSummary`
  equivalent while in there. `[cross-adapter]`
- **Codex Path B live smoke.** Requires a `CODEX_API_KEY`; ~5-minute
  rerun once available. `[needs-auth]`
- **OpenCode Anthropic OAuth live smoke.** `applyOpencodeAuth` only
  covers `type: "api"`; exercise the OAuth-via-CLI path.
  `[needs-auth]`
- **OpenCode descriptor — add `~/.opencode/bin` as a `homeRelative`
  candidate** so the Bun-global / vendor-bundle layout stops
  falling through to `pathLookup`. `[followup-track]`
- **Gemini smoke unblock.** Land the full 9.B.4 evidence once the
  Google-account ToS appeal clears (five what-would-be-tested items,
  all listed under gemini followups). `[vendor-blocker]`
- **Amp smoke unblock.** Land the full 9.B.5 evidence once paid
  credits are provisioned (five what-would-be-tested items, all
  listed under amp followups). `[vendor-blocker]`
- **Pi `get_session_stats` wiring on `turn_end`** so `usage` /
  `cost` events carry real tokens + USD (pre-existing 7.E item,
  re-confirmed by 9.B.6). `[pre-existing]`
- **Cursor usage-token derivation or vendor issue.** Cursor ACP
  server doesn't populate `usage.inputTokens` / `outputTokens` in the
  `session/prompt` result; file a vendor issue or derive from
  character counts adapter-side. `[vendor-blocker]`
- **Codex stderr surface.** `stderrHook` or broker seam so zero-exit
  empty-stream paths don't discard stderr; gives operators actionable
  context on vendor refusals. `[followup-track]`
- **Doctor auth-probe execution (`--resolve-clis --deep`).**
  `VendorCliAuthProbe` is declared on the descriptor shape but not
  executed today; deep probe would catch "CLI installed but not
  signed in" before the run. Listed in 9.A follow-ons;
  re-surfaced by 9.B.1. `[followup-track]`
- **`.shamu/state/` test DB isolation.** PR #32 pre-existing item,
  re-confirmed by 9.B.1 and 9.B.6's test-isolation discipline (both
  deliberately used tmpdir cwds). `[pre-existing]`

## What's NOT in this digest

- **9.A resolver's open items.** The `VendorCliAuthProbe` deep-probe,
  the `~/.opencode/bin` descriptor gap, and the descriptor-candidate
  coverage across new installer layouts all belong to 9.A's follow-on
  list, not 9.B.7. They are *surfaced* by the smokes but *owned* by
  the resolver track.
- **9.C deferred flow-wiring.** The `shamu run` CLI still lacks a
  `--vendor-opt key=value` surface and the dashboard has no adapter
  selector UI. Pi's fragment calls these out explicitly; both belong
  to the 9.C interactive-orchestrator track, not 9.B.7.
- **PR-25 JSDOM / SolidJS component-test wiring.** Listed in
  HANDOFF's "From PR #25 (web dashboard MVP)" followups. 9.B smokes
  do not touch `apps/web/`.
- **Linear 24h soak + signed single-binary release.** Both are
  Phase 8 owed manual steps; unchanged by 9.B.
- **A2A ↔ supervisor integration.** Post-Phase-8 follow-on track; no
  9.B fragment touches `packages/protocol/a2a/`.
- **OpenCode's pre-existing 7.A + #18/#19 items** (SSE cancel hook
  harness migration, `ServerOptions.env` passthrough, escalation-bus
  integration) — still open and unchanged by the 9.B.2 smoke.

## Capability-matrix drift sync

See [`../phase-7/capability-matrix.md`](../phase-7/capability-matrix.md)
for the generator output and the new "Phase 9.B observations"
subsection appended to it. The generator
(`bun scripts/generate-capability-matrix.ts`) was NOT re-run for 9.B.7
because no adapter's `src/capabilities.json` manifest changed during
the six smokes — the drift is at the *observation* layer (per-turn
usage tokens zeroed on Cursor / Amp / Pi despite
`usageReporting: "per-turn"` declaration), which the generator has no
vocabulary for today. The hand-edited observations subsection captures
the deltas with fragment cross-references so the next matrix
regeneration doesn't silently lose them.
