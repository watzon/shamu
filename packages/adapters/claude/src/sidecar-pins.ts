/**
 * Pinned version + per-platform SHA256 digests for the Claude "sidecar"
 * binary — the ~200MB native `claude` CLI that
 * `@anthropic-ai/claude-agent-sdk` subprocess-spawns for every turn.
 *
 * Phase 0.A (`docs/phase-0/bun-compat.md` Test 3) confirmed this binary
 * cannot usefully be absorbed by `bun build --compile` — it ships as a
 * per-platform optional dependency of the SDK. For single-binary Shamu
 * releases, `sidecar.ts` fetches the pinned version on first run and
 * verifies its SHA256 against `SIDECAR_PINS[<os>-<arch>]`.
 *
 * **The string values below are placeholders.** Real values are produced by
 * the release-automation workflow (Phase 8.C followup) against real
 * artifacts: the pipeline computes the SHA256 of each per-platform binary,
 * regenerates this file, opens a PR. Until that lands, the tests validate
 * the _shape_ of the pin table (string keys mapping to strings) rather
 * than the content.
 */

export const SIDECAR_VERSION = "PLACEHOLDER-0.0.0" as const;

/**
 * Map of `<os>-<arch>` → SHA256 hex digest. The key set here must line up
 * with the release targets shipped by `scripts/build-release.ts`: a user
 * running a darwin-arm64 Shamu binary needs a darwin-arm64 Claude sidecar.
 *
 * `Readonly<Record<...>>` keeps the map immutable at the type level; the
 * sidecar bootstrap does not mutate this table at runtime (G8 — frozen
 * manifest).
 */
export const SIDECAR_PINS: Readonly<Record<string, string>> = Object.freeze({
  "darwin-arm64": "PLACEHOLDER-SHA256-darwin-arm64",
  "linux-x64": "PLACEHOLDER-SHA256-linux-x64",
});

/**
 * Download URL template. The release-automation workflow fills in `{version}`,
 * `{os}`, and `{arch}` at artifact-publish time.
 *
 * TODO(sidecar-url): replace with the canonical URL once the release
 * pipeline and the final hosting target are confirmed. Likely shape:
 * `https://github.com/anthropics/claude-code/releases/download/v{version}/claude-{os}-{arch}`
 * — but the exact repo + filename convention need to match the Anthropic
 * release layout. Keeping this here (vs hard-coding in `sidecar.ts`) lets
 * the pipeline rewrite _one_ constant when vendor URL conventions change.
 */
export const SIDECAR_DOWNLOAD_URL_TEMPLATE =
  "https://github.com/anthropics/claude-code/releases/download/v{version}/claude-{os}-{arch}";

/**
 * Platform slugs we know how to look up a pin for. Kept narrow so a caller
 * passing an unsupported combo (e.g. windows) fails loudly at type- _and_
 * run- time.
 */
export type SidecarPlatform = keyof typeof SIDECAR_PLATFORMS;

/**
 * Enumeration of supported platform slugs. We keep these as a const object
 * (vs a string union alone) so tests can iterate the table when verifying
 * shape invariants.
 */
export const SIDECAR_PLATFORMS = Object.freeze({
  "darwin-arm64": "darwin-arm64",
  "linux-x64": "linux-x64",
} as const);
