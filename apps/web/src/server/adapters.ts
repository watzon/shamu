/**
 * Adapter registry for the web dashboard.
 *
 * Mirrors `apps/cli/src/services/adapters.ts` + `vendor-cli-registry.ts`.
 * Kept as a peer (not a re-export) because the CLI is an application, not a
 * library — `@shamu/web` must not depend on `@shamu/cli` (would produce a
 * cycle at publish time + inflate the `@shamu/web` build).
 *
 * The `VendorName` union from `@shamu/adapters-base/vendor-cli-resolver`
 * keeps the two registries in lockstep: missing an adapter here trips
 * `tsc` via `Readonly<Record<VendorName, …>>`.
 */

import type { AgentAdapter } from "@shamu/adapters-base";
import type { VendorCliDescriptor, VendorName } from "@shamu/adapters-base/vendor-cli-resolver";

/** Structural shape every adapter's `listModels()` returns. */
export interface ModelInfo {
  readonly id: string;
  readonly label: string;
  readonly default?: boolean;
}

interface AdapterModule {
  readonly load: () => Promise<AgentAdapter>;
  readonly descriptor: () => Promise<VendorCliDescriptor>;
  readonly models: () => Promise<readonly ModelInfo[]>;
}

/**
 * Per-adapter lazy loaders. Dynamic imports keep SDK cost off startup for
 * callers that only ever hit `/api/health`.
 *
 * The triple-arrow shape (`load`/`descriptor`/`models`) is all the web
 * server needs:
 *  - `load()` for `POST /api/runs` to instantiate + spawn.
 *  - `descriptor()` for `GET /api/adapters/available` to run `resolveVendorCli`.
 *  - `models()` for `GET /api/adapters/:vendor/models`.
 */
export const ADAPTER_MODULES: Readonly<Record<VendorName, AdapterModule>> = Object.freeze({
  echo: {
    load: async () => {
      const mod = await import("@shamu/adapter-echo");
      return new mod.EchoAdapter();
    },
    descriptor: async () => {
      const mod = await import("@shamu/adapter-echo");
      return mod.echoVendorCliDescriptor;
    },
    models: async () => {
      const mod = await import("@shamu/adapter-echo");
      return mod.listModels();
    },
  },
  claude: {
    load: async () => {
      const mod = await import("@shamu/adapter-claude");
      return new mod.ClaudeAdapter();
    },
    descriptor: async () => {
      const mod = await import("@shamu/adapter-claude");
      return mod.claudeVendorCliDescriptor;
    },
    models: async () => {
      const mod = await import("@shamu/adapter-claude");
      return mod.listModels();
    },
  },
  codex: {
    load: async () => {
      const mod = await import("@shamu/adapter-codex");
      return new mod.CodexAdapter();
    },
    descriptor: async () => {
      const mod = await import("@shamu/adapter-codex");
      return mod.codexVendorCliDescriptor;
    },
    models: async () => {
      const mod = await import("@shamu/adapter-codex");
      return mod.listModels();
    },
  },
  cursor: {
    load: async () => {
      const mod = await import("@shamu/adapter-cursor");
      return new mod.CursorAdapter();
    },
    descriptor: async () => {
      const mod = await import("@shamu/adapter-cursor");
      return mod.cursorVendorCliDescriptor;
    },
    models: async () => {
      const mod = await import("@shamu/adapter-cursor");
      return mod.listModels();
    },
  },
  gemini: {
    load: async () => {
      const mod = await import("@shamu/adapter-gemini");
      return new mod.GeminiAdapter();
    },
    descriptor: async () => {
      const mod = await import("@shamu/adapter-gemini");
      return mod.geminiVendorCliDescriptor;
    },
    models: async () => {
      const mod = await import("@shamu/adapter-gemini");
      return mod.listModels();
    },
  },
  amp: {
    load: async () => {
      const mod = await import("@shamu/adapter-amp");
      return new mod.AmpAdapter();
    },
    descriptor: async () => {
      const mod = await import("@shamu/adapter-amp");
      return mod.ampVendorCliDescriptor;
    },
    models: async () => {
      const mod = await import("@shamu/adapter-amp");
      return mod.listModels();
    },
  },
  opencode: {
    load: async () => {
      const mod = await import("@shamu/adapter-opencode");
      return new mod.OpencodeAdapter();
    },
    descriptor: async () => {
      const mod = await import("@shamu/adapter-opencode");
      return mod.opencodeVendorCliDescriptor;
    },
    models: async () => {
      const mod = await import("@shamu/adapter-opencode");
      return mod.listModels();
    },
  },
  pi: {
    load: async () => {
      const mod = await import("@shamu/adapter-pi");
      return new mod.PiAdapter();
    },
    descriptor: async () => {
      const mod = await import("@shamu/adapter-pi");
      return mod.piVendorCliDescriptor;
    },
    models: async () => {
      const mod = await import("@shamu/adapter-pi");
      return mod.listModels();
    },
  },
});

/** True iff `name` is a known adapter. */
export function isKnownAdapter(name: string): name is VendorName {
  return Object.hasOwn(ADAPTER_MODULES, name);
}

/** List of every adapter name. */
export function knownAdapterNames(): readonly VendorName[] {
  return Object.keys(ADAPTER_MODULES) as VendorName[];
}

/**
 * True iff the given adapter has a real vendor CLI. Echo is the sole
 * exception today — it runs entirely in-process.
 */
export function adapterHasVendorCli(name: VendorName): boolean {
  return name !== "echo";
}
