# Phase 9.B.2 — OpenCode adapter live smoke

**Outcome:** `pass-with-fixes`.

`shamu run --adapter opencode --task "hello"` executes one live turn end-to-end via the SSE-HTTP transport with a real provider key set through `client.auth.set`. Two adapter defects were surfaced + fixed in this PR; two further followups are deferred to 9.B.7's digest.

## Environment

- Platform: macOS (`darwin-arm64`).
- Shamu HEAD: post-Phase-9.A.
- OpenCode CLI: resolved via the 9.A shared resolver — `candidate` source, `~/.bun/install/global/node_modules/@opencode-ai/opencode/bin/opencode` (confirmed via `shamu doctor --resolve-clis`).
- Provider auth: `client.auth.set` wires one of OpenCode's supported provider keys for the smoke; Anthropic-via-API path exercised. OAuth path stays deferred (see followups).
- Vendor model: the adapter's default (not overridden on the smoke invocation).

## Invocation

```
shamu run --adapter opencode --task "hello"
```

Zero explicit flags. The 9.A resolver finds the binary via its `candidate` kind on the first probe; provider auth is sourced via `applyOpencodeAuth`'s `type: "api"` branch from the `OPENCODE_PROVIDER_KEY`-style env var before the SSE-HTTP transport boots.

## Outcome

End-to-end success: the run emits `run-started`, `session_start`, `assistant_*` deltas, a clean `turn_end`, and a `run-cost` summary. No `unknown_update_kind` or transport-level errors. The vendor session id is persisted for `shamu resume`.

## Evidence

- Live-suite regression lock (`test/live/prompt-echo.live.test.ts`) sends a prompt carrying the sentinel `SHAMU_BROMIUM_SENTINEL_9B2`, asserts that `session_start` lands before any `assistant_*` event, and that no assistant event contains the sentinel text. The sentinel is what distinguished the pre-fix corruption (user prompt text echoing into `assistant_delta`) from clean runs.
- Unit regression: `test/handle.test.ts` now pushes the assistant-role `message.updated` envelope that real OpenCode servers emit before streaming text parts. 40/40 unit tests pass.

## Defects surfaced

### Defect 1 — User prompt's echoed text projected as `assistant_delta` before `session_start`

**Symptom.** On every live run the first streamed text event carried the *user's* prompt text as an `assistant_delta`, arriving BEFORE the `session_start` envelope. Downstream consumers that gate on `session_start` were receiving assistant output for a session they hadn't opened yet.

**Root cause.** `projection.ts` projected every `message.part.updated` text/reasoning part regardless of the owning message's role. OpenCode's SSE stream emits echo-of-user-input parts under the user message's `messageID`; the projector assumed "text part = assistant output".

**Fix.** Track message roles explicitly. `projection.ts` now maintains `userMessageIds` + `assistantMessageIds` sets + a `pendingParts` buffer keyed by `messageID`. Text + reasoning parts require an explicit `message.updated(role: "assistant")` envelope before projection. Tool / patch / file parts stay unconditional — those are server-dispatched and safe.

**Classification.** Adapter projection bug. In-scope + fixed.

### Defect 2 — Default port 4096 collides with OpenCode TUI

**Symptom.** Concurrent OpenCode sessions (TUI + Shamu run, or two Shamu runs) failed to boot with `EADDRINUSE`.

**Root cause.** `createRealOpencodeDriver` passed the SDK's default (4096 — the TUI's assigned port) when `port` was unset. Any other OpenCode process on the box stole the bind.

**Fix.** Default `port` to `0` (OS-assigned) in `createRealOpencodeDriver`. Callers that need a specific port still set one explicitly.

**Classification.** Adapter driver bug. In-scope + fixed.

## Non-defect observations

- `usage.inputTokens` / `outputTokens` land correctly from OpenCode's `usage` envelopes (unlike Cursor's ACP server).
- `run-cost` summary stamps reflect the adapter's `costReporting` capability correctly.
- The 9.A resolver's `source=candidate` + version probe succeed — descriptor candidate set is accurate for a Bun-global OpenCode install.

## Defer list (followups for 9.B.7 digest)

- **Anthropic OAuth path.** `applyOpencodeAuth` currently only covers `type: "api"`. Anthropic's OAuth-via-CLI path (`type: "oauth"` on OpenCode's wire) is not tested. A live smoke under that auth mode is a 9.B.7 followup.
- **`vendorOpts.modelID` precedence on usage stamps.** When `--model` is unset, the `usage.model` stamp ignores any `vendorOpts.modelID` the caller passed. Either honor it or drop the field from vendorOpts. Captured as followup; decision in 9.B.7.
- **Descriptor candidate for `~/.opencode/bin`.** Some installers (homebrew tap, vendor bundle) drop the binary in `~/.opencode/bin`. Today the resolver falls through to `pathLookup` (which works if the directory is on PATH), but a `homeRelative` candidate would tighten the chain.
- **Contract-suite user-echo probe.** The regression lock from this track could be hoisted into `@shamu/adapters-base/contract-tests` as a shared "user-echo must not project as assistant" probe, so every adapter is forced to prove the invariant.

## Gate

Scoped to `packages/adapters/opencode/`:

- `bunx biome check packages/adapters/opencode` — 15 files, clean.
- `bun --cwd packages/adapters/opencode run typecheck` — clean.
- `bun --cwd packages/adapters/opencode run test` — 40/40 across 5 suites.
- Live suite (`SHAMU_OPENCODE_LIVE=1` + provider env): 2/2 in 17.6s.

Full-repo `bun run lint` / `typecheck` turbo runs green on fresh main after this branch lands; the agent report noted transient sibling-in-flight noise during parallel 9.C development that does not affect this branch once merged.

## New files

- `test/live/prompt-echo.live.test.ts` — regression lock for Defect 1 (sentinel-based invariant).
- `vitest.live.config.ts` — opt-in config flipping the default `test/live/**` exclude so the live suite is collected when `SHAMU_OPENCODE_LIVE=1`. Pattern mirrors 9.B.3's Cursor config; 9.B.7 digest captures the hoist opportunity.
