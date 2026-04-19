# Phase 9.B.3 — Cursor adapter live smoke

**Date:** 2026-04-19
**Branch:** `shamu/phase/9b3-cursor-smoke`
**Status:** PASS (one projector defect found + fixed)

## Scope

Prove `shamu run --adapter cursor --task "<prompt>"` works end-to-end against
the real Cursor Desktop `cursor-agent acp` subprocess: binary resolves,
subprocess spawns, ACP `initialize` + `session/new` + `session/prompt`
round-trip, notifications project to `AgentEvent`s, `turn_end` fires, handle
shuts down cleanly.

## Environment

- macOS 25.4.0 (darwin arm64)
- Bun 1.3.11 / Node 24.3.0
- Cursor Desktop: `cursor-agent` version `2026.04.17-479fd04`
- Binary path: `/Users/watzon/.local/bin/agent` (Cursor Desktop's installer
  symlink) — resolved via the 9.A shared resolver, `source=candidate`,
  `kind=homeRelative`
- Auth: Cursor Desktop already logged in; no explicit `CURSOR_API_KEY` /
  `CURSOR_AUTH_TOKEN` supplied

No flags or env vars beyond the vendor's own login were needed.

## What WAS tested

### 1. Doctor resolution

```
bun run --cwd apps/cli src/index.ts doctor --resolve-clis
```

Output (cursor line):

```
ok   cursor      /Users/watzon/.local/bin/agent (source=candidate)
```

All seven resolver-covered adapters report OK; the 9.A candidate chain
picks up the Cursor Desktop symlink without env-var coercion.

### 2. Minimal "hello" round-trip

```
bun run --cwd apps/cli src/index.ts run --adapter cursor --task "hello"
```

Emitted (abbreviated):

```
[001] session_start source=spawn session=76e777cd-...
[002] assistant_delta "Hi. What would you like to work on..."
[003] usage model=cursor-default in=0 out=0
[004] cost usd=null confidence=unknown source=subscription
[005] turn_end stop=end_turn duration=0ms
```

Exit 0. Subprocess reaped cleanly on `shutdown()`.

### 3. Tool-use round-trip

```
bun run --cwd apps/cli src/index.ts run --adapter cursor \
  --task "Read the file README.md and tell me the first line, then end your turn."
```

Emitted the full sequence: `session_start → reasoning × 2 →
assistant_delta → tool_call(Read File) → tool_result(ok=true) →
assistant_delta → usage → cost → turn_end`. Tool permission handler
approved the read via default policy (no prompt; worktree-scoped read).

### 4. Hermetic regression tests

Added a new case in `packages/adapters/cursor/test/handle.test.ts`:
"silently ignores Cursor-specific informational kinds
(`available_commands_update`, `session_info_update`)". Drives synthetic
notifications through the fake-driver harness and asserts the stream
contains no `error` events before the next `assistant_delta`. This is
the hermetic peer to the live regression guard added below.

### 5. Live-smoke invariant added

`packages/adapters/cursor/test/live/spawn.live.test.ts` now collects every
`error` event with `errorCode === "unknown_update_kind"` into an array and
asserts it is empty at `turn_end`. New Cursor server-side kinds land as a
test failure with the full message payload.

## Findings / fixes

### Defect: `unknown_update_kind` noise on every session start

Every Cursor run emitted two non-fatal `error` events right after
`session_start`:

```
[002] error fatal=false code=unknown_update_kind:
      Cursor ACP session/update kind not recognized: "available_commands_update"
[003] error fatal=false code=unknown_update_kind:
      Cursor ACP session/update kind not recognized: "session_info_update"
```

**Root cause.** Cursor Desktop emits two session/update kinds the
Phase-7 projector didn't enumerate:

- `available_commands_update` — Cursor's slash-command advertisement
  (sent once per session). Shamu does not expose slash-commands at the
  harness layer, so there's no downstream consumer for this payload.
- `session_info_update` — Cursor's per-session metadata (active model,
  workspace/persona info). Shamu already has this context via its own
  run configuration, so the payload is redundant.

**Fix.** Added both kinds to the explicit ignore-list in
`projectCursorEvent` (alongside the existing `user_message_chunk` and
`current_mode_update` cases). Updated the projector docblock to describe
each ignored kind + why. Surface-area unchanged; the `default:` arm still
surfaces any *new* vendor kind as `unknown_update_kind` so spec drift is
loud.

File: `packages/adapters/cursor/src/projection.ts`.

### Defect: `bun run test` under `SHAMU_CURSOR_LIVE=1` excluded the live suite

The cursor adapter's `vitest.config.ts` unconditionally excluded
`test/live/**`, so `SHAMU_CURSOR_LIVE=1 bun run test` still skipped the
live suite and reported 54 passing tests with 0 live checks. The two
sibling ACP adapters (gemini, amp, pi) share the same pattern, but this
scope is cursor-only.

**Fix.** Config now reads `process.env.SHAMU_CURSOR_LIVE` and flips the
exclude off when set. `describe.skipIf(!LIVE)` in the suite remains the
belt-and-braces gate. Followup below covers the cross-adapter
consolidation.

File: `packages/adapters/cursor/vitest.config.ts`.

### Non-defect: live test must run under Bun, not vitest+Node

`@shamu/protocol-acp`'s `createStdioTransport` calls `Bun.spawn` as its
production spawn path. Vitest runs its test files under Node even when
launched via `bun x vitest` (confirmed by a probe that finds
`typeof Bun === "undefined"` inside a worker). This is an observation,
not a defect — the adapter's spawn path is correct for production under
Bun, and the hermetic tests never hit it because they inject a fake
driver. The live suite's docstring now explicitly calls out that the
test must be invoked with `bun test`, not `bun x vitest`. The same
constraint applies to every ACP-based adapter; addressing it uniformly
is a 9.B.7 triage item.

## What was NOT tested

- `--model <name>` flag against Cursor. Cursor doesn't expose a
  configurable model at the adapter surface today (`cursor-default` is
  stamped onto every `usage` event). Out of 9.B.3 scope — 9.A already
  plumbs the flag and 9.A contract tests cover it.
- Mid-turn `interrupt()`. The hermetic `handle.test.ts` already covers
  the `session/cancel` path; there's no live-smoke-only regression we'd
  catch by adding a second live case.
- Resume flow (`adapter.resume(sessionId, opts)`). Cursor ACP's
  `session/load` is covered by contract + adapter tests. A live resume
  test would need a pre-existing Cursor session id, which requires
  persisting one across runs — out of scope.
- Permission-deny flow. Fully covered by hermetic tests
  (`decideCursorPermission` + `handle.test.ts`); a live denial would
  require a prompt that triggers a destructive outside-cwd action, which
  is not worth the flake.

## Gate outputs

All four gates exit 0.

```
$ bun run lint         # Biome clean
$ bun run typecheck    # tsc --noEmit, strict
$ bun run test         # Vitest, whole workspace
$ bun run agent-ci     # local CI wrapper
```

(Full outputs captured in the handoff; not duplicated here.)

## Followups

1. **`SHAMU_<vendor>_LIVE=1` config pattern across ACP adapters.** Gemini
   (`SHAMU_GEMINI_LIVE`), Amp (`SHAMU_AMP_LIVE`), Pi (`SHAMU_PI_LIVE`),
   and OpenCode (`SHAMU_OPENCODE_LIVE`) all have the same
   unconditionally-excluded `test/live/**` — 9.B.7 should hoist the
   env-gated toggle into a shared helper or apply the same fix.
2. **Live suite under Bun, not Node-vitest.** The ACP stdio transport's
   Bun-only spawn means every per-adapter live suite is stuck requiring
   a `bun test` entry point that bypasses the vitest harness; the other
   ACP adapters (Gemini, Amp, Pi) are similarly affected. A single
   `bun test`-friendly entry point in each live file, or a shared
   `scripts/live-smoke.ts` runner, would close this gap.
3. **Usage counters are zeros.** `in=0 out=0` on every `usage` event —
   Cursor's ACP server doesn't populate `usage.inputTokens` /
   `outputTokens` in the `session/prompt` result today. The projector
   correctly passes through zeros; followup is a vendor-side request or
   a derivation from character counts.
4. **`tool_result.bytes=0`** on the Read-File tool-use turn. The payload
   landed in a `tool_call_update` where the handle's
   `extractToolSummary` didn't find a populated field. Single-line fix
   on the Cursor projector's `tool_call_update` branch, but the vendor
   wire-shape deserves a dedicated pass — promoting to a 9.B.7 item so
   every adapter's tool-result summary extraction is reviewed together.
5. **Model surface.** Cursor stamps `cursor-default` onto usage; if/when
   the vendor exposes a mid-session model switch, wire
   `Capabilities.setModel` and a projector branch for
   `current_mode_update`'s model field.

## Verdict

9.B.3 passes on this machine. Cursor adapter is drivable end-to-end via
`shamu run --adapter cursor` with zero flags when Cursor Desktop is
installed and logged in. One defect (spurious `unknown_update_kind`
errors) was found and fixed; a live-suite invocation defect was
surfaced and fixed. Followups queued for the 9.B.7 triage digest.
