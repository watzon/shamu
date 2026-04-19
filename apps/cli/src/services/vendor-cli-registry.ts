/**
 * CLI-side vendor CLI descriptor registry.
 *
 * Central lookup table aggregating each adapter's exported
 * `vendorCliDescriptor` under its vendor name. Lives here (not in
 * `@shamu/adapters-base`) because the base package cannot depend on
 * sibling adapter packages — that would create a circular dependency.
 *
 * The `Record<VendorName, VendorCliDescriptor>` type enforces
 * exhaustiveness at compile time: missing an adapter here breaks `tsc`.
 * Add new adapters in lockstep with `VENDOR_NAMES` in the resolver and
 * `ADAPTER_LOADERS` in `services/adapters.ts`.
 */

import { ampVendorCliDescriptor } from "@shamu/adapter-amp/vendor-cli-descriptor";
import { claudeVendorCliDescriptor } from "@shamu/adapter-claude/vendor-cli-descriptor";
import { codexVendorCliDescriptor } from "@shamu/adapter-codex/vendor-cli-descriptor";
import { cursorVendorCliDescriptor } from "@shamu/adapter-cursor/vendor-cli-descriptor";
import { echoVendorCliDescriptor } from "@shamu/adapter-echo/vendor-cli-descriptor";
import { geminiVendorCliDescriptor } from "@shamu/adapter-gemini/vendor-cli-descriptor";
import { opencodeVendorCliDescriptor } from "@shamu/adapter-opencode/vendor-cli-descriptor";
import { piVendorCliDescriptor } from "@shamu/adapter-pi/vendor-cli-descriptor";
import type { VendorCliDescriptor, VendorName } from "@shamu/adapters-base/vendor-cli-resolver";

/**
 * Every shipped adapter's vendor-CLI descriptor. The `Record<VendorName,
 * …>` typing turns a missing key into a `tsc` error — the only
 * mechanism that keeps the registry and the `VENDOR_NAMES` tuple in
 * lockstep. Do NOT swap to a `Partial<…>` or a `Map`.
 */
export const VENDOR_CLI_DESCRIPTORS: Readonly<Record<VendorName, VendorCliDescriptor>> =
  Object.freeze({
    echo: echoVendorCliDescriptor,
    claude: claudeVendorCliDescriptor,
    codex: codexVendorCliDescriptor,
    cursor: cursorVendorCliDescriptor,
    gemini: geminiVendorCliDescriptor,
    amp: ampVendorCliDescriptor,
    opencode: opencodeVendorCliDescriptor,
    pi: piVendorCliDescriptor,
  });

export function getVendorCliDescriptor(vendor: VendorName): VendorCliDescriptor {
  return VENDOR_CLI_DESCRIPTORS[vendor];
}
