# Phase 8 — release binaries

Shamu's Phase 8 ops polish ships the CLI as a single Bun-compiled binary
plus a lazy-bootstrap story for the ~200MB per-platform Claude CLI that
the Claude adapter depends on. Phase 0.A (`docs/phase-0/bun-compat.md`
Test 3) confirmed the compile path works for the Shamu CLI shape on
darwin-arm64 and recommended the sidecar-bootstrap approach for vendor
binaries that can't be absorbed into the compiled artifact.

This document covers the release path landing in Phase 8.C Track 8.C.2.
Actual GitHub release publishing lands in a follow-on PR.

## Producing a release locally

```sh
# Build for the host target (darwin-arm64 or linux-x64 today)
bun scripts/build-release.ts

# Build for a specific target
bun scripts/build-release.ts --target=darwin-arm64
bun scripts/build-release.ts --target=linux-x64

# Build both targets into a custom outdir
bun scripts/build-release.ts --target=all --outdir=./dist/release
```

`build-release.ts` emits NDJSON progress events on stdout so a CI driver
can parse them:

```json
{"kind":"build-start","target":"darwin-arm64"}
{"kind":"build-done","target":"darwin-arm64","path":"./dist/release/shamu-darwin-arm64","sha256":"…","bytes":62951584}
```

For each target, the script writes:

- `<outdir>/shamu-<os>-<arch>` — the Bun-compiled executable (exec bit
  set on the owner).
- `<outdir>/shamu-<os>-<arch>.sha256` — single-line
  `<hex>  <filename>\n` that matches `sha256sum`/`shasum -a 256` output.

A smoke test lives at `scripts/build-release.test.ts`. It's gated so
`bun run test` doesn't rebuild the binary on every invocation:

```sh
SHAMU_RELEASE_BUILD_SMOKE=1 bun test scripts/build-release.test.ts
```

## Claude sidecar bootstrap

The Claude adapter spawns a per-platform `claude` CLI under the hood.
Phase 0.A measured that binary at ~200MB on darwin-arm64 and found
`bun build --compile` cannot usefully absorb it. Instead, the adapter
lazy-downloads it on first run, verifies the SHA256 against a pinned
manifest, and caches it for subsequent runs.

### Resolution precedence

`apps/cli/src/services/claude-sidecar-bootstrap.ts` :: `resolveClaudeCliPath`
checks, in order:

1. `shamu run --claude-cli <path>` — explicit override.
2. `$CLAUDE_CLI_PATH` — environment variable.
3. `ensureClaudeSidecar()` — downloads + verifies + caches if missing.
4. PATH fallback — return `null`, let the SDK resolve from `$PATH`.

The returned `source` field (`"explicit" | "env" | "sidecar" | "path"`)
is logged by `shamu run` so the operator can confirm which branch fired.

### Cache location

Mirrors the `XDG_CACHE_HOME` handling in the Cursor/Gemini/Amp/Pi
adapter env allow-lists:

| Platform | Default cache root |
|----------|--------------------|
| darwin-arm64 | `~/Library/Caches/shamu/claude-sidecar/<version>/claude` |
| linux-x64 | `$XDG_CACHE_HOME/shamu/claude-sidecar/<version>/claude` (falling back to `~/.cache/shamu/claude-sidecar/<version>/claude`) |

Pass `SHAMU_CLAUDE_SIDECAR_PATH` to fully override the cache lookup
(useful for sealed environments that pre-populate a sidecar via
configuration management).

### Retry policy

3 attempts with 1s / 4s / 9s waits between them. Any non-2xx HTTP
response or thrown `fetch` counts as a retryable failure. After the
third failure the bootstrap throws with an error naming the URL and
every per-attempt diagnostic.

### Atomic install

Downloaded bytes are written to `<cacheDir>/.partial-<uuid>`, the
SHA256 is verified, then the file is `rename`-d into place. An
interrupted download leaves only the `.partial-*` file; a later call
ignores it and retries.

### SHA mismatch handling

A mismatch throws loudly — the error names both the expected and
actual digests and points to `packages/adapters/claude/src/sidecar-pins.ts`
as the file that needs regeneration. No silent fallback; trust is the
whole point of the sidecar.

## Pin file

`packages/adapters/claude/src/sidecar-pins.ts` exports three constants:

- `SIDECAR_VERSION` — pinned version string.
- `SIDECAR_PINS` — `Readonly<Record<"darwin-arm64" | "linux-x64", string>>`
  mapping each supported platform to the SHA256 of its pinned binary.
- `SIDECAR_DOWNLOAD_URL_TEMPLATE` — template URL containing `{version}`,
  `{os}`, `{arch}` placeholders the bootstrap fills in at request time.

These values are placeholders today (marked with a `TODO(sidecar-url)`
comment). The tests validate the _shape_ of the table (non-empty string
values, required keys) rather than the content, so a release-automation
PR can regenerate the file without editing tests.

### Where the real pins come from

A future release-automation workflow (Phase 8.C follow-on) will:

1. Build or obtain the per-platform `claude` binary at the chosen
   version.
2. Compute `sha256` of each artifact.
3. Publish the artifacts to the chosen hosting target (likely GitHub
   Releases on `anthropics/claude-code`).
4. Regenerate `sidecar-pins.ts` with the real version, SHA digests, and
   URL template.
5. Open a PR. CI rebuilds, runs contract tests against the sidecar-
   enabled Claude adapter, and blocks until the adapter suite is green.

Until that workflow lands, the sidecar bootstrap fails loudly on
download (placeholder URL template) or on SHA verification (placeholder
digests). Callers with a real Claude CLI on PATH or via
`$CLAUDE_CLI_PATH` remain unaffected — those branches short-circuit
before the download.
