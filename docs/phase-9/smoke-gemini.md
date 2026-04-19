# Phase 9.B.4 — Gemini adapter smoke

**Track:** 9.B.4 — Gemini smoke + fix.
**Outcome:** `blocked-on-vendor`.
**Last updated:** 2026-04-19.

## Blocker

The user's Google account that owns the Gemini CLI login is currently flagged as ToS-disabled, so `gemini --acp` cannot open a real session against the Google backend — any `session/new` attempt would fail during auth before the adapter ever sees a first `session/update`. An appeal is the only unblock path; there is no Shamu-side workaround (the adapter faithfully wires the documented `authenticate` ACP method and both accepted env var aliases `GEMINI_API_KEY` / `GOOGLE_AI_API_KEY`, but the backing account is what the upstream rejects). This is the durable reason this track ships as a stub: until the appeal resolves, the live-turn evidence this fragment is supposed to carry cannot be produced. HANDOFF.md "Vendor / environment" tracks the same block.

## What would be tested when unblocked

1. **Live turn via `gemini --acp`** with the `gemini` binary resolved by the 9.A shared resolver (no explicit `--gemini-cli` flag, no `GEMINI_CLI_PATH` env). Run:
   ```
   shamu run --adapter gemini --task "print hello world"
   ```
   Expected: exit 0, a single `session_start` envelope followed by projected `assistant_delta` events, a `usage` event with non-zero `tokens.output`, a `cost { usd: null, source: "subscription" }` event, and a `turn_end` with `stopReason: "end_turn"`.
2. **Streaming ACP `session/update` notifications** projected into the Shamu event stream. Confirm the handle emits `assistant_delta` chunks interleaved with any `tool_call` / `tool_result` pairs as the model streams, not just a single final payload. The projector is exercised end-to-end (unit-tested today with synthetic updates; live smoke is the first proof against a real Gemini backend).
3. **`session/request_permission` round-trip** surfacing as an `AgentEvent`. Force a `Write` or `Shell` tool invocation ("create a file `hi.txt`" or "run `echo hello`"), confirm the orchestrator sees a `permission_request` envelope with `decision` ∈ `{allow, deny, ask}`, and that the G4 path-scope + G5 shell-AST gates fire for out-of-worktree / `$()` inputs (adapter today maps denies to a fatal `error` with the gate's own error code).
4. **Upstream bug `google-gemini/gemini-cli#22647`** (non-ACP writes bleed into the JSON-RPC stdout stream). Confirm Shamu surfaces each malformed frame as an `error` event with `errorCode: "acp_protocol"`, `fatal: false`, and that the run keeps going — it must NOT crash the handle. The protocol-acp client validates every line via `decodeFrames` and invokes `onProtocolError`; the Gemini handle remaps those to non-fatal agent events. Unit-tested via `test/handle.test.ts > maps AcpProtocolError to a non-fatal error event (gemini-cli#22647)`; live smoke is the first real-stream confirmation.
5. **Model precedence.** With `--model gemini-2.5-pro` and `adapters.gemini.defaultModel = "gemini-2.0-flash"` in `shamu.config.ts`, the stamped `usage.model` in emitted events MUST be `gemini-2.5-pro`. Remove `--model` → falls back to `gemini-2.0-flash`. Remove both → falls back to the adapter default (`"gemini-default"` placeholder in `GeminiHandle`; in practice the Gemini CLI picks its own default when no model is pinned). This exercises the 9.A flag → config → adapter-default chain end-to-end through `SpawnOpts.model`.

## What works today without vendor auth

The 9.A shared vendor-CLI resolver runs entirely without any Google-account state — it only asks the filesystem where `gemini` lives. On this machine `shamu doctor --resolve-clis` finds the binary via the Homebrew candidate:

```
$ shamu doctor --resolve-clis
shamu doctor

  ok   bun                     1.3.11
  ok   node                    24.3.0
  ok   git                     2.50.1
  ok   docker                  28.5.2
  ok   platform                darwin
  ok   config                  loaded: defaults (no shamu.config.ts found)
  ok   keychain                macOS Keychain reachable (2 keychain(s)).
  ok   audit_events chain      0 rows
  ok   egress broker           denied CONNECT in 2ms on 127.0.0.1:58225
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

The Gemini binary (`@google/gemini-cli`, version `0.37.1` on this host — `gemini --version` → `0.37.1`) resolves at `/opt/homebrew/bin/gemini` via the `candidate` kind (the `{ kind: "absolute", path: "/opt/homebrew/bin/gemini" }` entry in `packages/adapters/gemini/src/vendor-cli-descriptor.ts`). This proves the descriptor's candidate set is correct for a Homebrew-installed Gemini CLI. The `source=candidate` tag in the output is how the resolver distinguishes "found via a descriptor candidate" from `source=pathLookup` (fell through to `Bun.which()` / `$PATH` scan) — both are acceptable terminal states; this is a structural proof that the `pathLookup` fallback in the descriptor is reachable when none of the explicit candidates match (see the `opencode` row above, which lands via `pathLookup`).

When the appeal lifts and the user re-captures this fragment, this same `doctor --resolve-clis` block should appear unchanged — the block is independent of Google-account state.

## Pre-flight tests (non-live proof we have today)

The adapter's unit + contract tests all pass without any Gemini backend. These are the non-live proof we can already point at:

```
$ cd packages/adapters/gemini && bun run test
 ✓ test/driver.test.ts (15 tests) 4ms
 ✓ test/vendor-cli-descriptor.test.ts (4 tests) 3ms
 ✓ test/adapter.test.ts (12 tests) 6ms
 ✓ test/handle.test.ts (10 tests) 10ms
 ✓ test/contract.test.ts (17 tests) 23ms

 Test Files  5 passed (5)
      Tests  58 passed (58)
```

Summary of what each suite covers:

- **`test/adapter.test.ts`** (12 tests) — frozen capability manifest (G8); factory; spawn/resume wiring; `session/new` rollback; `authenticate` threading of `vendorOpts.apiKey`; `SpawnOpts.env` merge semantics; `driverFactory` injection seam.
- **`test/driver.test.ts`** (15 tests) — `resolveGeminiBinaryPath` precedence (explicit `vendorCliPath` → `GEMINI_CLI_PATH` env → `which(gemini)` → structured "not found" error); `resolveAuth` precedence (`vendorOpts.apiKey` → `GEMINI_API_KEY` → `GOOGLE_AI_API_KEY` → null for "relies on `gemini /login`"); `applyGeminiAuth` RPC + `GeminiAuthError` wrapping; `createRealGeminiDriver` `SpawnError` on missing binary + `transportFactory` injection seam.
- **`test/handle.test.ts`** (10 tests) — event projection (`session_start` + `assistant_delta` + `usage` + `turn_end`); tool-call/tool-result linkage; G4 path-scope deny; G5 shell-gate deny; unknown `sessionUpdate` kinds → non-fatal error; cooperative interrupt; prompt failure → `error` + `turn_end`; **`AcpProtocolError` → non-fatal `error` event (gemini-cli#22647)**; `setModel` dispatches `unstable_setSessionModel`; `setModel` graceful fallback on RPC failure.
- **`test/contract.test.ts`** (17 tests) — the shared `runAdapterContractSuite` against a scripted ACP-client double: every manifest-declared capability has a behavioural proof; path-scope + shell-gate probes run under Gemini's tool-name dictionary (`Shell`, `Edit`, `Write`, `ReadFile`); warnings on `patch-metadata` + `error-surfaces` reflect Gemini's surface, not a defect.
- **`test/vendor-cli-descriptor.test.ts`** (4 tests) — descriptor declares `binaryNames: ["gemini"]`; includes the `@google/gemini-cli` npm-global layout; runs the shared `runVendorCliResolverContract` against every candidate kind.

None of these tests spawn a real `gemini --acp` subprocess. The one test that does — `test/live/spawn.live.test.ts > spawns a real gemini --acp, runs a prompt, drains to turn_end` — is explicitly gated on `SHAMU_GEMINI_LIVE=1` and is the one that this track would flip green once the appeal lifts.

## Unblock procedure

1. **Appeal succeeds.** User re-logs into the Google account via `gemini /login` (or the equivalent browser flow) and confirms `gemini` can open an interactive session against the account.
2. **Re-run the live smoke:**
   ```
   SHAMU_GEMINI_LIVE=1 bun --cwd packages/adapters/gemini run test -- test/live/spawn.live.test.ts
   ```
   and the end-to-end CLI turn:
   ```
   shamu run --adapter gemini --task "print hello world"
   ```
   Capture the full event envelope stream + exit code.
3. **Append a `## When unblocked` section** to the bottom of this fragment with: the date the appeal cleared; the `shamu run` output; the `spawn.live.test.ts` pass line; and any defects surfaced along the way (each defect becomes its own follow-on phase-9 item, per the 9.B.1–9.B.6 "discovery + fix, not rewrite" scope rule).
4. **Flip the outcome** in the Phase 9.B.7 triage digest (`docs/phase-9/adapter-smoke.md`) from `blocked-on-vendor` to the real Phase 9.B outcome (`pass` or `pass-with-followups`) and tick `PLAN.md` line 837.

Until step 3 happens, this fragment's outcome stays `blocked-on-vendor` and the 9.B.7 digest reflects the same for the Gemini column.
