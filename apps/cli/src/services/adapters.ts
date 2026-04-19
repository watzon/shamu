/**
 * Adapter registry for the CLI.
 *
 * Maps a user-facing adapter name to an async factory that dynamically
 * imports the concrete adapter module and returns an instance. Dynamic
 * import keeps vendor SDK cost off the startup path for callers that only
 * ever use, say, the echo adapter.
 *
 * The `AdapterName` union matches `VendorName` from
 * `@shamu/adapters-base/vendor-cli-resolver` — the two live in lockstep so
 * the vendor-CLI resolver's exhaustiveness guarantee stays intact. Add
 * new adapters in BOTH places.
 */

import type { AgentAdapter } from "@shamu/adapters-base";
import type { VendorName } from "@shamu/adapters-base/vendor-cli-resolver";

/** Adapter name union. Aligned with `VendorName` (compile-time check below). */
export type AdapterName = VendorName;

type AdapterLoader = () => Promise<AgentAdapter>;

const ADAPTER_LOADERS: Readonly<Record<AdapterName, AdapterLoader>> = {
  echo: async () => {
    const mod = await import("@shamu/adapter-echo");
    return new mod.EchoAdapter();
  },
  claude: async () => {
    // Dynamic import keeps the Anthropic SDK off the startup path for users
    // running `shamu run --adapter echo`.
    const mod = await import("@shamu/adapter-claude");
    return new mod.ClaudeAdapter();
  },
  codex: async () => {
    const mod = await import("@shamu/adapter-codex");
    return new mod.CodexAdapter();
  },
  cursor: async () => {
    const mod = await import("@shamu/adapter-cursor");
    return new mod.CursorAdapter();
  },
  gemini: async () => {
    const mod = await import("@shamu/adapter-gemini");
    return new mod.GeminiAdapter();
  },
  amp: async () => {
    const mod = await import("@shamu/adapter-amp");
    return new mod.AmpAdapter();
  },
  opencode: async () => {
    const mod = await import("@shamu/adapter-opencode");
    return new mod.OpencodeAdapter();
  },
  pi: async () => {
    const mod = await import("@shamu/adapter-pi");
    return new mod.PiAdapter();
  },
};

/** True iff `name` is a recognized adapter. Cheap, does no I/O. */
export function isKnownAdapter(name: string): name is AdapterName {
  return Object.hasOwn(ADAPTER_LOADERS, name);
}

/** List of registered adapter names — handy for usage strings. */
export function knownAdapterNames(): readonly AdapterName[] {
  return Object.keys(ADAPTER_LOADERS) as AdapterName[];
}

/** Resolve and instantiate a named adapter. */
export async function loadAdapter(name: AdapterName): Promise<AgentAdapter> {
  const loader = ADAPTER_LOADERS[name];
  return loader();
}

/**
 * True iff the given adapter has a real vendor CLI. Echo is the sole
 * exception today — it runs entirely in-process. Callers that build
 * "which adapters are resolvable on this machine" lists use this to skip
 * echo in the binary-resolution stage.
 */
export function adapterHasVendorCli(name: AdapterName): boolean {
  return name !== "echo";
}
