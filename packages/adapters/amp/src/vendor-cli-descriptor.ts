/**
 * Amp adapter — vendor CLI descriptor.
 *
 * Binary is `amp` (from `@sourcegraph/amp`). Shipped via `npm install
 * -g @sourcegraph/amp`. Amp requires paid credits for non-interactive
 * `amp -x` runs; the resolver cares only about binary presence.
 */

import type { VendorCliDescriptor } from "@shamu/adapters-base";

export const ampVendorCliDescriptor: VendorCliDescriptor = {
  adapter: "amp",
  binaryNames: ["amp"],
  candidates: [
    // Bun global.
    {
      kind: "homeRelative",
      segments: [".bun", "install", "global", "node_modules", "@sourcegraph", "amp", "bin", "amp"],
    },
    // npm global.
    { kind: "homeRelative", segments: [".npm-global", "bin", "amp"] },
    // Homebrew.
    { kind: "absolute", path: "/opt/homebrew/bin/amp" },
    { kind: "absolute", path: "/usr/local/bin/amp" },
    // XDG local bin.
    { kind: "homeRelative", segments: [".local", "bin", "amp"] },
    { kind: "pathLookup" },
  ],
  installHint: "Install Amp via `npm install -g @sourcegraph/amp`.",
};
