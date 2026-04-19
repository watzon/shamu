/**
 * Claude adapter — vendor CLI descriptor.
 *
 * Binary is `claude` (from `@anthropic-ai/claude-code`). The sidecar
 * bootstrap is NOT listed in `candidates` — it has a potential network
 * cost (downloads a ~200MB binary on first run) so the CLI wires it into
 * `VendorCliResolverInput.lastChance` instead. That way sidecar bootstrap
 * only fires when every on-disk candidate misses.
 *
 * See `packages/adapters/claude/src/sidecar.ts` for the bootstrap itself
 * and `apps/cli/src/services/claude-sidecar-bootstrap.ts` for the
 * resolver-adapter wrapper.
 */

import type { VendorCliDescriptor } from "@shamu/adapters-base";

export const claudeVendorCliDescriptor: VendorCliDescriptor = {
  adapter: "claude",
  binaryNames: ["claude"],
  candidates: [
    // Bun global install (`bun install -g @anthropic-ai/claude-code`).
    {
      kind: "homeRelative",
      segments: [
        ".bun",
        "install",
        "global",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "cli.js",
      ],
    },
    // npm global install (`npm install -g @anthropic-ai/claude-code`).
    { kind: "homeRelative", segments: [".npm-global", "bin", "claude"] },
    // Homebrew — Apple Silicon.
    { kind: "absolute", path: "/opt/homebrew/bin/claude" },
    // Homebrew — Intel / Linuxbrew.
    { kind: "absolute", path: "/usr/local/bin/claude" },
    // XDG local bin.
    { kind: "homeRelative", segments: [".local", "bin", "claude"] },
    // PATH fallback — respects PATH-based installers (asdf, mise, etc.).
    { kind: "pathLookup" },
  ],
  installHint:
    "Install the Claude CLI via `npm install -g @anthropic-ai/claude-code` (or `bun install -g @anthropic-ai/claude-code`); Shamu will auto-bootstrap a sidecar binary on first run when shipped as a single binary.",
};
