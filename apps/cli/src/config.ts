/**
 * shamu.config.ts loader.
 *
 * - Bun runs TS modules natively, so `await import(path)` is the cleanest way
 *   to load `shamu.config.ts` and grab its default export.
 * - Validates with Zod. Returns a Result so callers can branch on
 *   USAGE (bad shape) vs CONFIG_ERROR (file missing/broken parse).
 * - Default search: `./shamu.config.ts`, `./shamu.config.js`. Missing file is
 *   OK — defaults are returned.
 *
 * The schema is intentionally minimal in Phase 1 and will grow as vendors,
 * tunnels, and flow configs land in later phases.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { VENDOR_NAMES } from "@shamu/adapters-base/vendor-cli-resolver";
import { z } from "zod";

/**
 * Per-adapter user overrides. Read by the Phase 9.A vendor-CLI resolver
 * and by `shamu run --adapter <name>` when wiring `SpawnOpts.model`.
 *
 * - `cliPath` — absolute path to a pre-authenticated vendor binary.
 *   Precedence: `--<vendor>-cli` flag wins > `<VENDOR>_CLI_PATH` env wins
 *   > this field wins > built-in candidate list wins > PATH fallback.
 * - `cliVersionConstraint` — semver range the resolved binary must
 *   satisfy. The resolver runs the adapter's `versionProbe` and throws
 *   `VendorCliVersionMismatchError` on a miss.
 * - `envOverrides` — extra env merged into `SpawnOpts.env` for this
 *   adapter. Empty-string values delete the key. Intended for pinning a
 *   provider API key in the config vs. export-ing it globally.
 * - `defaultModel` — default model passed via `SpawnOpts.model` when the
 *   user did NOT supply `--model`. CLI flag wins over this.
 */
export const adapterConfigEntrySchema = z
  .object({
    cliPath: z.string().optional(),
    cliVersionConstraint: z.string().optional(),
    envOverrides: z.record(z.string(), z.string()).optional(),
    defaultModel: z.string().optional(),
  })
  .strict();

export type AdapterConfigEntry = z.infer<typeof adapterConfigEntrySchema>;

/**
 * Adapter-name enum derived at runtime from the shared `VENDOR_NAMES`
 * tuple. Keeping the source of truth in `@shamu/adapters-base` avoids
 * double-updating whenever a new adapter ships.
 *
 * Zod v4's `enum` helper accepts a readonly tuple as the first element;
 * we cast away the readonly to satisfy the type signature while keeping
 * the runtime array immutable.
 */
const adapterEnum = z.enum([...VENDOR_NAMES] as [string, ...string[]]);

export const shamuConfigSchema = z
  .object({
    swarm: z
      .object({
        name: z.string().min(1, "swarm.name must be a non-empty string"),
      })
      .default({ name: "default" }),
    vendors: z.record(z.string(), z.object({}).passthrough()).default({}),
    /**
     * Per-adapter configuration block — new in Phase 9.A. Keyed by
     * `VendorName`; unknown keys raise. See `adapterConfigEntrySchema`
     * for the per-entry shape.
     */
    adapters: z.record(adapterEnum, adapterConfigEntrySchema).default({}),
    paths: z
      .object({
        state: z.string().default(".shamu"),
      })
      .default({ state: ".shamu" }),
  })
  .strict();

export type ShamuConfig = z.infer<typeof shamuConfigSchema>;

/** Default configuration returned when no file is present. */
export function defaultConfig(): ShamuConfig {
  return shamuConfigSchema.parse({});
}

export type ConfigErrorKind = "parse" | "validate" | "import";

export class ConfigError extends Error {
  readonly kind: ConfigErrorKind;
  readonly path: string;
  readonly issues?: readonly z.core.$ZodIssue[];

  constructor(params: {
    kind: ConfigErrorKind;
    path: string;
    message: string;
    issues?: readonly z.core.$ZodIssue[];
    cause?: unknown;
  }) {
    super(params.message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "ConfigError";
    this.kind = params.kind;
    this.path = params.path;
    if (params.issues) this.issues = params.issues;
  }
}

export interface ConfigResult {
  readonly ok: true;
  readonly value: ShamuConfig;
  readonly source: string | null;
}

export interface ConfigErrorResult {
  readonly ok: false;
  readonly error: ConfigError;
}

export type LoadConfigResult = ConfigResult | ConfigErrorResult;

const CANDIDATES = ["shamu.config.ts", "shamu.config.js", "shamu.config.mjs"] as const;

/**
 * Async loader. Resolves `./shamu.config.ts` (or `.js`, `.mjs`) relative to
 * `cwd` (or honors `explicitPath`). Validates and returns a Result.
 */
export async function loadConfig(params: {
  explicitPath?: string;
  cwd?: string;
}): Promise<LoadConfigResult> {
  const cwd = params.cwd ?? process.cwd();
  const explicit = params.explicitPath;

  const target = explicit ?? discoverConfigPath(cwd);
  if (target === null) {
    return { ok: true, value: defaultConfig(), source: null };
  }

  if (explicit && !existsSync(explicit)) {
    return {
      ok: false,
      error: new ConfigError({
        kind: "import",
        path: explicit,
        message: `config file not found: ${explicit}`,
      }),
    };
  }

  let mod: { default?: unknown };
  try {
    // Dynamic import with file:// URL so absolute paths work on all platforms.
    const url = pathToFileURL(target).href;
    mod = (await import(url)) as { default?: unknown };
  } catch (cause) {
    return {
      ok: false,
      error: new ConfigError({
        kind: "parse",
        path: target,
        message: `failed to import ${target}: ${formatError(cause)}`,
        cause,
      }),
    };
  }

  const raw = mod.default ?? mod;
  const parsed = shamuConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: new ConfigError({
        kind: "validate",
        path: target,
        message: `config at ${target} failed validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        issues: parsed.error.issues,
      }),
    };
  }
  return { ok: true, value: parsed.data, source: target };
}

function discoverConfigPath(cwd: string = process.cwd()): string | null {
  for (const name of CANDIDATES) {
    const candidate = `${cwd}/${name}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function formatError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
