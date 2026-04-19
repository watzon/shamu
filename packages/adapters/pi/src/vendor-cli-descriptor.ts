/**
 * Pi adapter — vendor CLI descriptor.
 *
 * Binary is `pi` (from `@mariozechner/pi-coding-agent`). Shipped via
 * `npm install -g @mariozechner/pi-coding-agent`.
 */

import type { VendorCliDescriptor } from "@shamu/adapters-base";

export const piVendorCliDescriptor: VendorCliDescriptor = {
  adapter: "pi",
  binaryNames: ["pi"],
  candidates: [
    // Bun global.
    {
      kind: "homeRelative",
      segments: [
        ".bun",
        "install",
        "global",
        "node_modules",
        "@mariozechner",
        "pi-coding-agent",
        "bin",
        "pi",
      ],
    },
    // npm global.
    { kind: "homeRelative", segments: [".npm-global", "bin", "pi"] },
    // Homebrew.
    { kind: "absolute", path: "/opt/homebrew/bin/pi" },
    { kind: "absolute", path: "/usr/local/bin/pi" },
    // XDG local bin.
    { kind: "homeRelative", segments: [".local", "bin", "pi"] },
    { kind: "pathLookup" },
  ],
  installHint: "Install Pi via `npm install -g @mariozechner/pi-coding-agent`.",
};
