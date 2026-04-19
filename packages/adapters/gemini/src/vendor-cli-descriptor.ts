/**
 * Gemini adapter — vendor CLI descriptor.
 *
 * Binary is `gemini` (from `@google/gemini-cli`). Shipped via `npm
 * install -g @google/gemini-cli` on the user's machine; Shamu does not
 * take a runtime dependency on the package (~111MB unpacked).
 *
 * See `docs/phase-7/adapter-transports.md` for the stdout-corruption
 * (gemini-cli#22647) workaround — handled at the projector, not here.
 */

import type { VendorCliDescriptor } from "@shamu/adapters-base";

export const geminiVendorCliDescriptor: VendorCliDescriptor = {
  adapter: "gemini",
  binaryNames: ["gemini"],
  candidates: [
    // Bun global.
    {
      kind: "homeRelative",
      segments: [
        ".bun",
        "install",
        "global",
        "node_modules",
        "@google",
        "gemini-cli",
        "bin",
        "gemini",
      ],
    },
    // npm global.
    { kind: "homeRelative", segments: [".npm-global", "bin", "gemini"] },
    // Homebrew.
    { kind: "absolute", path: "/opt/homebrew/bin/gemini" },
    { kind: "absolute", path: "/usr/local/bin/gemini" },
    // XDG local bin.
    { kind: "homeRelative", segments: [".local", "bin", "gemini"] },
    { kind: "pathLookup" },
  ],
  installHint: "Install Gemini CLI via `npm install -g @google/gemini-cli`.",
};
