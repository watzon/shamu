/**
 * Codex adapter — vendor CLI descriptor.
 *
 * Binary is `codex` (from `@openai/codex`). The CLI is required for
 * ChatGPT-OAuth runs (`codexPathOverride` on the SDK); API-key runs
 * don't use the CLI directly but still benefit from having it installed
 * (the SDK spawns it internally). Path-resolution precedence lives in
 * the shared resolver; auth (API key vs CLI token) stays narrow in
 * `auth.ts`.
 */

import type { VendorCliDescriptor } from "@shamu/adapters-base";

export const codexVendorCliDescriptor: VendorCliDescriptor = {
  adapter: "codex",
  binaryNames: ["codex"],
  candidates: [
    // Bun global.
    {
      kind: "homeRelative",
      segments: [".bun", "install", "global", "node_modules", "@openai", "codex", "bin", "codex"],
    },
    // npm global.
    { kind: "homeRelative", segments: [".npm-global", "bin", "codex"] },
    // Homebrew — Apple Silicon.
    { kind: "absolute", path: "/opt/homebrew/bin/codex" },
    // Homebrew — Intel / Linuxbrew.
    { kind: "absolute", path: "/usr/local/bin/codex" },
    // XDG local bin.
    { kind: "homeRelative", segments: [".local", "bin", "codex"] },
    { kind: "pathLookup" },
  ],
  installHint:
    "Install the Codex CLI via `npm install -g @openai/codex`, or sign in via `codex login` and point Shamu at the resulting binary.",
};
