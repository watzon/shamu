/**
 * Cursor adapter — vendor CLI descriptor.
 *
 * Binary is `cursor-agent` (from Cursor Desktop). Cursor does NOT ship
 * an npm package for the binary; the canonical install path is
 * `~/.local/bin/agent` (the desktop-installer's symlink). The
 * env-override on the old driver was `CURSOR_AGENT_PATH`; the shared
 * resolver uses the uniform `CURSOR_CLI_PATH` to match every other
 * adapter, with `CURSOR_AGENT_PATH` still honored as a fallback via the
 * adapter's local descriptor consumer for backward-compat (see
 * `apps/cli/src/services/vendor-cli-registry.ts` where the CLI
 * resolves).
 */

import type { VendorCliDescriptor } from "@shamu/adapters-base";

export const cursorVendorCliDescriptor: VendorCliDescriptor = {
  adapter: "cursor",
  binaryNames: ["cursor-agent", "agent"],
  candidates: [
    // Cursor Desktop's installer symlink.
    { kind: "homeRelative", segments: [".local", "bin", "agent"] },
    // Cursor Desktop on Homebrew (hypothetical; not official today).
    { kind: "absolute", path: "/opt/homebrew/bin/cursor-agent" },
    { kind: "absolute", path: "/usr/local/bin/cursor-agent" },
    { kind: "pathLookup" },
  ],
  installHint:
    "Install Cursor Desktop (https://cursor.sh); the desktop bundle places `agent` at `~/.local/bin/agent`. Shamu supports `cursor-agent` on PATH as an alias.",
};
