/**
 * Consumer-side flow-module contract for `shamu flow run`.
 *
 * Every flow module (e.g. `@shamu/flows-plan-execute-review`) conforms to
 * a narrow, runtime-validated surface:
 *
 *   - `flowDefinition`: a FlowDefinition object.
 *   - `registerRunners(registry, opts)`: wires the module's runners into
 *     the RunnerRegistry the engine will use.
 *   - Optional `name: string`.
 *   - Optional `parseOptions(record): Partial<RegisterRunnersOptions>`.
 *
 * This module is internal to the CLI — intentionally not exposed from
 * `apps/cli/package.json`'s exports. We duplicate the contract types here
 * rather than importing from `@shamu/flows-plan-execute-review` because
 * Track 4.B may be running concurrently; taking a hard dep on 4.B would
 * couple ship order. Any flow module, built in-tree or out, works as long
 * as it matches this shape.
 *
 * The validation uses Zod. Runners themselves are *functions*, which Zod
 * can't introspect meaningfully — we only verify their presence and that
 * they're callable. The flow definition, in contrast, is plain data, so
 * we hand it to `@shamu/core-flow`'s typing after shape-check without
 * further parsing (the engine's topological walk will catch any
 * structural problems at run-time).
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RunnerRegistry } from "@shamu/core-flow/runners";
import type { FlowDefinition } from "@shamu/core-flow/types";
import { z } from "zod";

/**
 * Options the CLI passes into `registerRunners(...)`. Matches the
 * contract PLANned in Track 4.C. Optional fields let a flow module
 * ignore knobs it doesn't care about — `workspaceCwd` is the only one
 * guaranteed to be populated.
 */
export interface RegisterRunnersOptions {
  readonly anthropicCliPath?: string;
  readonly codexCliPath?: string;
  readonly workspaceCwd: string;
  readonly maxIterations?: number;
  readonly plannerModel?: string;
  readonly executorModel?: string;
  readonly reviewerModel?: string;
}

/**
 * Public surface a flow module is required to export. `name` and
 * `parseOptions` are optional; everything else is mandatory.
 */
export interface FlowModule {
  readonly flowDefinition: FlowDefinition;
  readonly registerRunners: (registry: RunnerRegistry, opts: RegisterRunnersOptions) => void;
  readonly name?: string;
  readonly parseOptions?: (cliOpts: Record<string, string>) => Partial<RegisterRunnersOptions>;
}

/**
 * Runtime shape check. Zod is permissive on `flowDefinition.nodes` — we
 * only need the outer keys; the engine owns deeper validation. We treat
 * `registerRunners` as an opaque callable via `z.custom` because Zod does
 * not model function signatures.
 */
const flowDefinitionShape = z.object({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  nodes: z.array(z.unknown()),
  entry: z.string().min(1),
});

const callable = z.custom<(...args: readonly unknown[]) => unknown>(
  (v) => typeof v === "function",
  { message: "expected a function" },
);

export const flowModuleSchema = z.object({
  flowDefinition: flowDefinitionShape,
  registerRunners: callable,
  name: z.string().min(1).optional(),
  parseOptions: callable.optional(),
});

/**
 * Raise if a dynamic-imported module doesn't match our contract.
 * `specSource` is the raw spec the user passed (a package name or path)
 * so the error string is actionable. We don't print the full Zod issue
 * tree — just the top-level missing/invalid keys, which is what the CLI
 * user actually needs.
 */
export class FlowModuleContractError extends Error {
  constructor(
    public readonly specSource: string,
    public readonly reason: string,
  ) {
    super(`flow module '${specSource}' does not match the shamu flow contract: ${reason}`);
    this.name = "FlowModuleContractError";
  }
}

/**
 * Resolve a module spec to a value `await import(...)` understands.
 *
 * Supported:
 *   - Bare package name (e.g. `@shamu/flows-plan-execute-review`): let
 *     Node module resolution handle it. We pass the string through as-is.
 *   - Absolute or relative path ending in `.ts`/`.js`: convert to a
 *     `file://` URL so Bun/Node resolves from disk without going through
 *     the require resolver. Relative paths resolve against `baseDir`
 *     (defaults to process.cwd()).
 */
export function resolveModuleSpec(spec: string, baseDir: string = process.cwd()): string {
  if (spec.length === 0) {
    throw new TypeError("resolveModuleSpec: spec must be a non-empty string");
  }
  const looksLikePath =
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.endsWith(".ts") ||
    spec.endsWith(".js") ||
    spec.endsWith(".mjs");
  if (!looksLikePath) return spec;
  // Resolve relative paths against baseDir; absolute paths untouched.
  const abs = spec.startsWith("/") ? spec : joinPath(baseDir, spec);
  return pathToFileURL(abs).href;
}

// Tiny local path joiner. Keeping it dependency-free so the module can be
// imported by test fixtures that don't want a node:path transitive dep
// (and Bun/Node path semantics are fine either way on macOS + Linux).
function joinPath(base: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmedBase}/${rel.startsWith("./") ? rel.slice(2) : rel}`;
}

/**
 * Heuristic: does an error look like a bare-specifier `@shamu/*` resolution
 * failure raised from a user-supplied flow module that lives outside our
 * workspace? Matches Bun + Node error codes/messages.
 */
function isShamuBareSpecifierResolutionError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  const text = typeof message === "string" ? message : "";
  const looksLikeModuleNotFound =
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /Cannot find (module|package)/i.test(text);
  if (!looksLikeModuleNotFound) return false;
  return /@shamu\//.test(text);
}

/**
 * Fallback loader for user-supplied flow modules that live OUTSIDE the
 * CLI's workspace tree and therefore can't resolve `@shamu/*` bare
 * specifiers against their own directory. Copies the file into a
 * CLI-internal shim directory (which sits inside `apps/cli/`, so Bun's
 * ESM loader walks up into `apps/cli/node_modules/@shamu/*`) and
 * imports the copy.
 *
 * Kept minimal: we only copy the ONE file. Flow modules that `import`
 * other user-owned files are out of scope — those live in a workspace
 * package and take the direct-path route.
 */
async function loadViaCliWorkspaceShim(absPath: string): Promise<Record<string, unknown>> {
  // Anchor the shim dir against THIS file's location so it always lands
  // inside the CLI package tree regardless of where the caller's cwd is.
  // `import.meta.url` is a `file://` URL to this compiled file; that
  // file lives under `apps/cli/` (src at dev time, dist after build),
  // either of which is under the same package root.
  const thisFileUrl = new URL(import.meta.url);
  const thisFilePath = fileURLToPath(thisFileUrl);
  // Walk up to the `apps/cli` root (two levels up from `.../src/commands/`).
  const cliRoot = resolve(dirname(thisFilePath), "..", "..");
  const shimDir = join(cliRoot, ".shamu-flow-shim");
  mkdirSync(shimDir, { recursive: true });

  // Dedupe with a per-source key so repeated invocations on the same
  // path reuse the same shim file (keeps the dir bounded for daemons).
  // A short hash of the absolute path keeps filenames legal.
  const key = hashPath(absPath);
  const base = basename(absPath);
  const shimPath = join(shimDir, `${key}-${base}`);
  try {
    copyFileSync(absPath, shimPath);
  } catch {
    // If the copy fails, fall back to a temp location. Extremely rare —
    // only happens if `apps/cli/.shamu-flow-shim` isn't writable (e.g.
    // read-only deploy). The temp-dir copy is still a strict improvement
    // over the original (it preserves the user's module content) even if
    // it may itself lack `@shamu/*` resolution. Callers get a clear
    // error either way.
    const fallback = join(tmpdir(), "shamu-flow-shim", `${key}-${base}`);
    mkdirSync(dirname(fallback), { recursive: true });
    copyFileSync(absPath, fallback);
    const url = pathToFileURL(fallback).href;
    return (await import(url)) as Record<string, unknown>;
  }

  const url = pathToFileURL(shimPath).href;
  return (await import(url)) as Record<string, unknown>;
}

/**
 * djb2-ish non-cryptographic hash. Only need stability + short output so
 * shim filenames are deterministic across runs without a runtime dep.
 */
function hashPath(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  // Unsigned hex, 8 chars.
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Dynamic-import `spec`, validate the module's surface, and return the
 * typed handle. Throws `FlowModuleContractError` on any mismatch; any
 * other failure (import resolution, syntax error in the module itself)
 * propagates through unchanged so the caller sees the underlying cause.
 *
 * Fallback: when `spec` is an ABSOLUTE PATH outside the CLI's workspace
 * and the direct import fails because a `@shamu/*` bare specifier can't
 * resolve from the module's own directory (Phase 6.D trap), we retry by
 * shimming the file into the CLI's own tree so Bun's ESM loader finds
 * `apps/cli/node_modules/@shamu/*`. This lets users author flow modules
 * in arbitrary locations as long as they only depend on shamu packages.
 * Bare package specs and paths inside a workspace package always take
 * the direct route.
 */
export async function loadFlowModule(
  spec: string,
  opts: { readonly baseDir?: string } = {},
): Promise<FlowModule> {
  const target = resolveModuleSpec(spec, opts.baseDir ?? process.cwd());
  let imported: Record<string, unknown>;
  try {
    imported = (await import(target)) as Record<string, unknown>;
  } catch (err) {
    // Only the file:// / absolute-path case is a candidate for the shim
    // fallback. A bare package name that fails to resolve is a legitimate
    // "module not installed" error and should propagate unchanged.
    const isFileUrl = typeof target === "string" && target.startsWith("file://");
    if (isFileUrl && isShamuBareSpecifierResolutionError(err)) {
      const absPath = fileURLToPath(target);
      imported = await loadViaCliWorkspaceShim(absPath);
    } else {
      throw err;
    }
  }
  const parsed = flowModuleSchema.safeParse(imported);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const path = firstIssue?.path.join(".") ?? "<root>";
    const message = firstIssue?.message ?? "shape mismatch";
    throw new FlowModuleContractError(spec, `${path}: ${message}`);
  }
  // Zod's parsed output types the callables as `(...unknown[]) => unknown`;
  // we re-narrow here so the engine gets the real signatures.
  const m = parsed.data;
  const out: FlowModule = {
    flowDefinition: imported.flowDefinition as FlowDefinition,
    registerRunners: imported.registerRunners as FlowModule["registerRunners"],
    ...(m.name !== undefined ? { name: m.name } : {}),
    ...(m.parseOptions !== undefined
      ? { parseOptions: imported.parseOptions as NonNullable<FlowModule["parseOptions"]> }
      : {}),
  };
  return out;
}
