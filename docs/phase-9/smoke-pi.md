# Phase 9.B.6 — Pi live smoke

Pi is the custom-JSONL-over-stdio adapter from Phase 7.E. Phase 9.B.6's
job is to prove `shamu run --adapter pi --task …` actually works end-to-
end against the real `pi --mode rpc` subprocess on a freshly installed
machine, and to cover the `--no-session` opt-out path the adapter wires
up via `vendorOpts.ephemeralSession`.

## TL;DR

| Flavor                    | Wire shape                              | Result |
|---------------------------|-----------------------------------------|--------|
| Default session (on disk) | `pi --mode rpc`                         | PASS   |
| Opt-out (`--no-session`)  | `pi --mode rpc --no-session`            | PASS   |

Two defects surfaced in the Pi adapter during the first live attempt
and were fixed in this PR; the remaining followups are called out in
"Deferred" below and belong to cross-adapter tracks.

## Prereqs

- Pi CLI installed (`npm install -g @mariozechner/pi-coding-agent`, or
  Homebrew: `brew install pi`). Version verified against live smoke:
  `pi --version` → `0.67.68`.
- A provider logged in via `pi login <provider>` (auth persisted under
  `~/.pi/agent/auth.json`) OR a provider-specific env var Pi reads
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `GROQ_API_KEY`, `CEREBRAS_API_KEY`).
- Pi's default provider is `google`. If Google isn't authenticated,
  point at one of your configured providers via `SHAMU_PI_PROVIDER_ID`
  (vitest harness) or `--model <provider>/<model>` (CLI — see caveat
  in "Deferred" below about vendorOpts reach).

## Invocation

### Flavor 1 — default session (on-disk JSONL)

```sh
# Any directory outside the shamu worktree is fine; Pi writes session
# state under ~/.pi/agent/sessions/<cwd-slug>/ regardless of cwd.
cd /tmp
bun /Users/watzon/Projects/personal/shamu/apps/cli/src/index.ts \
  run --adapter pi \
      --task "Say hello in one word then end the turn." \
      --model openai-codex/gpt-5
```

Observed events (abridged):

```
[001] session_start source=spawn session=pi-session-pending
[002] assistant_delta Hello
[003] assistant_message stop=end_turn Hello
[004] usage model=openai-codex/gpt-5 in=0 out=0
[005] cost usd=null confidence=unknown source=subscription
[006] turn_end stop=end_turn duration=0ms
run-cost … adapter=pi role=executor usd=0.000000 [exact=0 estimate=0 unknown=1] subscriptionRuns=1 …
```

Exit code: `0`.

### Flavor 2 — `--no-session` opt-out

The CLI has no `--vendor-opt` flag yet (see "Deferred"), so the
`--no-session` flavor is exercised via the vitest live harness, which
calls the Pi adapter directly with `vendorOpts.ephemeralSession: true`.
That value appends `--no-session` to the Pi spawn argv:

```ts
const handle = await adapter.spawn({
  runId: newRunId(),
  cwd: scratchCwd, // a fresh mkdtemp path per test
  vendorOpts: { ephemeralSession: true, promptTimeoutMs: 60_000 },
});
```

Invocation:

```sh
cd packages/adapters/pi
SHAMU_PI_LIVE=1 \
SHAMU_PI_PROVIDER_ID=openai-codex \
SHAMU_PI_MODEL_ID=openai-codex/gpt-5 \
bun x vitest run --config ./vitest.live.config.ts
```

The test drains to `turn_end` AND asserts no new files landed under
Pi's cwd-scoped discovery directory
(`~/.pi/agent/sessions/<slugified-cwd>/`) — i.e., the location
`pi --resume` / `pi --continue` would scan. Both flavors run
back-to-back in this config. Observed output:

```
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

### Pi 0.67.68 quirk: `--no-session` still drops a transcript in cwd

While writing the smoke, we noticed that Pi 0.67.68 drops a full
session-shaped JSONL into the subprocess cwd when the RPC protocol
completes a turn, even with `--no-session` set. Invoking `pi --mode rpc
--no-session` directly without any RPC commands produces no file, and
no file lands under `~/.pi/agent/sessions/<slug>/` — so the discovery-
path opt-out still works. The cwd copy is out-of-scope for our
ephemeral-session assertion (Pi-side vendor behavior; tracked as a
followup in the digest track). Every real caller of the Pi adapter
should use a throwaway cwd anyway (the run's working directory is
never the shamu tree); we document this so future tracks don't mistake
the cwd copy for a leak in our wiring.

## Defects surfaced + fixed in this PR

1. **`resolvePiBinaryPath` mis-resolved under vitest's Node worker.**
   The Pi driver's default `which` implementation gated on
   `typeof Bun !== "undefined"` and returned `null` when the runtime
   wasn't Bun — which is precisely what happens when `bun x vitest`
   runs the live config (vitest spawns a Node worker). Fix: mirror the
   shared resolver's PATH-scan fallback so `pi` resolves under Node too.
   Lives in `packages/adapters/pi/src/driver.ts` (`defaultWhichImpl`).
2. **`defaultSpawnImpl` hard-failed under Node.** The Bun-only
   subprocess spawner threw "createRealPiDriver requires Bun; tests
   should inject spawnImpl" whenever the Bun global was absent, which
   made the existing live test unusable as written. Fix: keep `Bun.spawn`
   as the production path; fall back to `node:child_process.spawn`
   with a `PiSpawnLike`-shaped adapter for the vitest runner. The
   fallback is a live-smoke aid — every real caller is Bun-resident.

## Deferred (cross-adapter, not in scope)

1. **CLI has no `vendorOpts` surface.** `shamu run` / `resume` expose
   `--<vendor>-cli` and `--model`, but not `vendorOpts.ephemeralSession`,
   `vendorOpts.providerID`, or `vendorOpts.modelID`. The Pi adapter
   currently reads the Pi `--provider` and `--model` spawn flags from
   `vendorOpts.providerID` / `vendorOpts.modelID`, not from the generic
   `SpawnOpts.model` the CLI threads. Consequence: `shamu run --adapter
   pi --model openai-codex/gpt-5` stamps the requested model into
   `usage` events but does NOT set `--model` on the Pi spawn — Pi
   resolves its own default provider at the vendor layer. For the
   openai-codex auth on this machine that happens to work (the vendor
   picks the logged-in provider), but Google-default installs without
   a Google key will need a config-driven vendorOpts path. Correct
   scoping: a 9.C-adjacent track that lands a generic `--vendor-opt
   key=value` surface (or a typed per-adapter flag set) AND wires the
   existing CLI `--model` into the adapter's native model field.
2. **Usage + cost are zeroed.** `turn_end` events come back with
   `usage model=… in=0 out=0` and `cost usd=null confidence=unknown
   source=subscription`. This is the open followup from Phase 7.E
   ("Real usage + cost via `get_session_stats` on Pi `turn_end`"). The
   smoke doesn't regress it — the path is just not implemented yet.
3. **`@shamu/shared/credentials` integration for `resolvePiAuth`.**
   Still stubbed. Pi's auth continues to flow through its own on-disk
   store; no shamu credential plumbing is expected here until a Pi
   follow-on track lands.
4. **`tool_execution_update` progress events → `stdout` events.** Not
   observed in these smokes because the prompt was a plain "say hello"
   that triggered no tools. Followup from 7.E remains open.
5. **`test:live` npm script on `packages/adapters/pi`.** Today the
   only live-smoke entry point is `bun x vitest run --config
   ./vitest.live.config.ts`. A sibling script would save operators a
   long command line. Matches the other adapters' state.
6. **Pi's cwd-scoped session copy under `--no-session` is vendor-side.**
   Worth filing a tiny issue upstream; scope-wise, an adapter-side
   mitigation would mean either wiping `<cwd>/<iso-ts>_<ulid>.jsonl` on
   shutdown (racy) or passing `--session-dir /dev/null` (not supported
   by Pi). Out of single-PR scope; belongs with the 9.B.7 triage digest.

## Gate

Every workspace check green after the fixes (run from worktree root):

```
bun run lint        # biome check — 608 files, no fixes
bun run typecheck   # 29/29 typecheck tasks pass
bun run test        # 29/29 test tasks pass (22 files / 104 tests in CLI;
                    # 7 files / 77 tests in adapter-pi)
bun run agent-ci    # no relevant workflows yet (branch unpushed) — exit 0
```

## Files

- `packages/adapters/pi/src/driver.ts` — `defaultWhichImpl` PATH-scan
  fallback + `spawnViaNode` Node-process fallback in `defaultSpawnImpl`.
- `packages/adapters/pi/test/live/spawn.live.test.ts` — rewritten to
  cover the default AND `--no-session` flavors; the opt-out assertion
  diffs Pi's cwd-scoped session dir before/after.
- `packages/adapters/pi/vitest.live.config.ts` — new sibling vitest
  config that flips the default `test/live/**` exclude into an include
  so `bun x vitest run --config ./vitest.live.config.ts` picks up only
  the live-gated file. Matches the OpenCode adapter's pattern.
