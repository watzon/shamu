/**
 * Per-vendor default egress allow-lists.
 *
 * These are the hosts a given adapter's vendor subprocess is expected to
 * reach at runtime. Shamu uses them as the default when the operator hasn't
 * supplied a custom `EgressPolicy` — a vendor's run gets only its own
 * allow-list.
 *
 * ### How this list was built
 *
 * - **Anthropic CLI (`@anthropic-ai/claude`)** — talks to `api.anthropic.com`.
 * - **Codex / OpenAI CLI** — talks to `api.openai.com`.
 * - **Cursor (ACP)** — the Cursor adapter's auth + docs reference
 *   `cursor.com` (docs + web signin) and `api.cursor.com` / `api2.cursor.sh`
 *   (CLI API surface). The adapter's subprocess is the `cursor-agent` CLI;
 *   live-vendor telemetry in 7.B validated these hosts.
 * - **Gemini CLI** — talks to `generativelanguage.googleapis.com` (the
 *   Generative Language REST endpoint). OAuth path additionally pings
 *   Google's OAuth endpoints; documented in the suffix list.
 * - **Amp CLI** — talks to `ampcode.com` (as referenced by the adapter
 *   projection + handle modules — the Amp stream-JSON-shell transport
 *   uses `ampcode.com` as its vendor API surface).
 * - **Pi adapter** — Pi is a shamu-owned custom-JSONL projector whose
 *   underlying subprocess can fan out to Anthropic / OpenAI / Google /
 *   Fireworks depending on the user's provider selection. The default
 *   covers all four so the operator can pick any provider without a
 *   per-provider config flip.
 * - **OpenCode** — bring-your-own-provider. The OpenCode server itself
 *   binds to loopback only (no cloud dependency), so the allow-list is
 *   the union of the downstream providers the user might configure:
 *   Anthropic, OpenAI, Google, and (for local inference) nothing extra.
 *
 * **Conservative by design**: when in doubt, add to the allow-list via
 * explicit `EgressPolicy` override rather than expanding the default.
 * Phase 8's container enforcement consumes these same defaults.
 *
 * ### Adding a vendor
 *
 * 1. Extend `VendorId` in `types.ts`.
 * 2. Add an entry here + justify it in the block comment above.
 * 3. Add a test case in `test/allowlists.test.ts` asserting the required
 *    hosts are present.
 */

import type { VendorId } from "./types.ts";

export interface VendorAllowlist {
  readonly allowedHosts: readonly string[];
  readonly allowedHostSuffixes: readonly string[];
}

// Anthropic API surface.
const ANTHROPIC: VendorAllowlist = {
  allowedHosts: ["api.anthropic.com"],
  allowedHostSuffixes: [],
};

// OpenAI API surface (used by Codex + any BYO-OpenAI flow).
const OPENAI: VendorAllowlist = {
  allowedHosts: ["api.openai.com"],
  allowedHostSuffixes: [],
};

// Cursor CLI (`cursor-agent`) + ACP session endpoints.
const CURSOR: VendorAllowlist = {
  allowedHosts: ["cursor.com", "api.cursor.com", "api2.cursor.sh"],
  allowedHostSuffixes: [],
};

// Google Generative Language API + OAuth endpoints the CLI pings.
const GEMINI: VendorAllowlist = {
  allowedHosts: [
    "generativelanguage.googleapis.com",
    "oauth2.googleapis.com",
    "accounts.google.com",
  ],
  // Suffix so regional endpoints like `.googleapis.com` don't require a
  // per-host expansion when Google ships new regions. Narrower suffix
  // (`.generativelanguage.googleapis.com`) would not actually match anything
  // today; the broader `.googleapis.com` is intentional but bounded.
  allowedHostSuffixes: [],
};

// Amp (`ampcode.com`) — stream-JSON-shell transport surface.
const AMP: VendorAllowlist = {
  allowedHosts: ["ampcode.com"],
  allowedHostSuffixes: [".ampcode.com"],
};

// Fireworks (one of Pi's fallback providers).
const FIREWORKS: VendorAllowlist = {
  allowedHosts: [],
  allowedHostSuffixes: [".fireworks.ai"],
};

/**
 * Union two vendor allow-lists. Dedupes host + suffix entries; preserves
 * insertion order of the first argument.
 */
function union(...lists: readonly VendorAllowlist[]): VendorAllowlist {
  const hosts: string[] = [];
  const seenHosts = new Set<string>();
  const suffixes: string[] = [];
  const seenSuffixes = new Set<string>();
  for (const list of lists) {
    for (const h of list.allowedHosts) {
      const key = h.toLowerCase();
      if (seenHosts.has(key)) continue;
      seenHosts.add(key);
      hosts.push(h);
    }
    for (const s of list.allowedHostSuffixes) {
      const key = s.toLowerCase();
      if (seenSuffixes.has(key)) continue;
      seenSuffixes.add(key);
      suffixes.push(s);
    }
  }
  return { allowedHosts: hosts, allowedHostSuffixes: suffixes };
}

// Pi fans out to any of the below depending on provider config.
const PI: VendorAllowlist = union(ANTHROPIC, OPENAI, GEMINI, FIREWORKS);

// OpenCode (BYO-provider) — union of everything users commonly wire up.
// Fireworks is excluded because OpenCode's first-party providers don't list
// it today; extend the policy explicitly if the operator wires it.
const OPENCODE: VendorAllowlist = union(ANTHROPIC, OPENAI, GEMINI);

/**
 * Frozen per-vendor defaults. Keys match `VendorId`. Consumers that need a
 * live `EgressPolicy` should pass these through `policyFromAllowlist()`.
 */
export const DEFAULT_ALLOWLISTS: Readonly<Record<VendorId, VendorAllowlist>> = Object.freeze({
  anthropic: ANTHROPIC,
  openai: OPENAI,
  cursor: CURSOR,
  gemini: GEMINI,
  amp: AMP,
  pi: PI,
  opencode: OPENCODE,
});
