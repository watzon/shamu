/**
 * OpenCode adapter — vendor CLI descriptor.
 *
 * OpenCode is SSE-HTTP, so there are two operating modes:
 *
 * 1. **Attach mode**: operator already has an OpenCode server running
 *    and sets `vendorOpts.attachBaseUrl`. No binary required.
 * 2. **Owned-server mode**: the adapter invokes `createOpencode()` from
 *    `@opencode-ai/sdk`, which spawns the server from the npm-resolvable
 *    `opencode` binary. Shamu does take a runtime dep on the SDK, so
 *    `createOpencode()` finds the binary via the SDK's own resolution —
 *    this descriptor is a hint for `shamu doctor --resolve-clis` and
 *    for the web dashboard's "is this adapter runnable" probe.
 *
 * A missing `opencode` binary is NOT a run-blocking error in attach
 * mode. The doctor surface treats "not found" as a warning for
 * OpenCode while still treating it as "fail" for every other adapter.
 */

import type { VendorCliDescriptor } from "@shamu/adapters-base";

export const opencodeVendorCliDescriptor: VendorCliDescriptor = {
  adapter: "opencode",
  binaryNames: ["opencode"],
  candidates: [
    // Bun global.
    {
      kind: "homeRelative",
      segments: [
        ".bun",
        "install",
        "global",
        "node_modules",
        "@opencode-ai",
        "opencode",
        "bin",
        "opencode",
      ],
    },
    // npm global.
    { kind: "homeRelative", segments: [".npm-global", "bin", "opencode"] },
    // Homebrew.
    { kind: "absolute", path: "/opt/homebrew/bin/opencode" },
    { kind: "absolute", path: "/usr/local/bin/opencode" },
    // XDG local bin.
    { kind: "homeRelative", segments: [".local", "bin", "opencode"] },
    { kind: "pathLookup" },
  ],
  installHint:
    "Install OpenCode via `npm install -g @opencode-ai/opencode` (or use attach-mode with a pre-running server via `vendorOpts.attachBaseUrl`).",
};
