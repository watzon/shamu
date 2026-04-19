# Amp live-smoke — Phase 9.B.5

## Outcome

`blocked-on-vendor`

## Blocker

Sourcegraph's Amp CLI requires paid credits before it will accept
non-interactive `amp -x` invocations; without a credited account the CLI
refuses to produce stream-JSON output and Shamu's adapter has no live
surface to exercise. The repository owner has not yet provisioned credits
for the Amp account tied to the workstation running these smokes, so this
gate stands until they do. The 9.A descriptor + 7.D stream-JSON-shell
adapter are wired correctly (all non-live tests pass — see below), but the
final live turn cannot be observed until credits land. This stub exists so
the 9.B.7 digest records the full adapter matrix rather than silently
skipping the Amp row.

## What would be tested when unblocked

- **Live turn via `amp -x`.** A full stream-JSON-shell conversation with
  credits loaded, exercising the `send` → stdin JSONL write → stdout NDJSON
  parse loop end-to-end against the real binary.
- **`formatUserTurn()` stdin shape on a live dev machine.** Picks up the
  outstanding 7.D follow-up (HANDOFF line 201) — confirm the
  `{"type":"user","message":{"role":"user","content":[{"type":"text",...}]}}`
  payload in `packages/adapters/amp/src/handle.ts:95` is actually the
  shape `amp -x` accepts on stdin, and that no escaping or envelope
  adjustments are required.
- **Streaming JSON projection into Shamu's `AgentEvent` stream.** Verify
  `packages/adapters/amp/src/projection.ts` correctly maps every live
  frame type (assistant/tool_use/tool_result/usage/error/final) into the
  canonical `AgentEvent` kinds, with no unhandled frames escaping as
  warnings.
- **Model precedence:** `--model` flag > `adapters.amp.defaultModel` config
  entry > adapter default. Confirm by spawning once with each override in
  isolation and inspecting the model field on emitted `usage` events.
- **Cost reporting accuracy.** The Amp capability manifest
  (`packages/adapters/amp/src/capabilities.json`) declares
  `costReporting: "subscription"`, and the projection stamps
  `kind: "cost"` events with `confidence: "unknown"` + `source: "subscription"`
  (see `projection.ts:298-301`). Confirm this matches the first live
  usage — i.e. that Amp genuinely does not expose per-turn USD and the
  confidence/source fields accurately describe what the orchestrator can
  know.

## What works today without vendor auth

`shamu doctor --resolve-clis` runs independently of Amp credits; it only
probes whether the `amp` binary is on `PATH` / in a known install
location. Actual invocation against this worktree on 2026-04-19:

```
shamu doctor

  ok   bun                     1.3.11
  ok   node                    24.3.0
  ok   git                     2.50.1
  ok   docker                  28.5.2
  ok   platform                darwin
  ok   config                  loaded: defaults (no shamu.config.ts found)
  ok   keychain                macOS Keychain reachable (2 keychain(s)).
  ok   audit_events chain      0 rows
  ok   egress broker           denied CONNECT in 3ms on 127.0.0.1:58224
  ok   clock skew              skew=0s (vs pool.ntp.org)
  --   webhook server          no daemon detected (set SHAMU_LINEAR_WEBHOOK_PORT or LINEAR_WEBHOOK_PORT to probe a running instance)
  --   tunnel scope            no CLOUDFLARED_CONFIG_PATH set; manual verify recommended when running `shamu linear tunnel`
  ok   vendor CLI resolution   all 7 adapter CLI(s) resolved

  vendor CLIs:
    ok   claude      /Users/watzon/.local/bin/claude (source=candidate)
    ok   codex       /opt/homebrew/bin/codex (source=candidate)
    ok   cursor      /Users/watzon/.local/bin/agent (source=candidate)
    ok   gemini      /opt/homebrew/bin/gemini (source=candidate)
    ok   amp         /Users/watzon/.local/bin/amp (source=candidate)
    ok   opencode    /Users/watzon/.opencode/bin/opencode (source=pathLookup)
    ok   pi          /opt/homebrew/bin/pi (source=candidate)

result: all checks ok.
```

The Amp binary resolves at `/Users/watzon/.local/bin/amp` via the 9.A
vendor-CLI candidate list. Resolution succeeds; only the credits-backed
live turn is gated.

## Pre-flight test

Non-live unit + contract tests in `packages/adapters/amp/test/` pass on
this branch (run with `bun test` from `packages/adapters/amp/`):

| File | Tests | Result |
| --- | --- | --- |
| `test/adapter.test.ts` | 13 | pass |
| `test/contract.test.ts` | 17 | pass |
| `test/driver.test.ts` | 15 | pass |
| `test/handle.test.ts` | 15 | pass |
| `test/vendor-cli-descriptor.test.ts` | 4 | pass |

Aggregate: `64 pass / 1 skip / 0 fail` across the 6 test files (including
the harness). The single skip is an explicit live-gated case inside the
non-live suite; the actual live suite lives under
`packages/adapters/amp/test/live/spawn.live.test.ts` and is not run here.

## Unblock procedure

1. **Provision credits.** Sign into <https://ampcode.com> on the account
   tied to the workstation, purchase credits, and confirm `amp -x "ping"`
   returns a stream-JSON response from an interactive shell.
2. **Run the Shamu smoke.**
   ```sh
   shamu run --adapter amp --task "hello"
   ```
   Capture full stdout/stderr plus the emitted `AgentEvent` stream.
3. **Append evidence.** Add a new `## Live run — <UTC timestamp>` section
   to this file (below `Unblock procedure`) containing: the exact command
   invocation, the resolved model, a trimmed sample of the `AgentEvent`
   stream, and the first live `cost` event's stamped
   `confidence` + `source` values.
4. **Flip outcome in 9.B.7 digest.** Change `blocked-on-vendor` to `pass`
   (or `fail` with diagnosis) in the 9.B.7 adapter-smoke digest, tick the
   9.B.5 checkbox in `PLAN.md`, and clear the 7.D `formatUserTurn()`
   follow-up in `HANDOFF.md` once the stdin shape is confirmed.
