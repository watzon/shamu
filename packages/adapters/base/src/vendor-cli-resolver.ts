/**
 * Shared vendor-CLI resolver.
 *
 * Phase 9.A pulled every adapter's ad-hoc `resolveXxxBinaryPath` into one
 * place. The resolver walks a uniform precedence chain — explicit → env →
 * `shamu.config.ts` entry → per-adapter candidate locations → `PATH`/Bun.which
 * → optional `lastChance` hook — and returns structured metadata the CLI and
 * `shamu doctor --resolve-clis` can surface to operators.
 *
 * Descriptors are **data only**: each adapter exports a
 * `VendorCliDescriptor` listing binary name(s) + candidate locations. The
 * resolver is the sole executor — adapters MUST NOT call `fs.existsSync` or
 * `Bun.which` in their descriptor file. This split keeps the descriptor
 * serializable (useful for telemetry, doctor output, the web dashboard) and
 * makes contract testing straightforward.
 *
 * ### Error taxonomy
 *
 * - `VendorCliNotFoundError` — every source in the chain returned "missing";
 *   `.attempts` lists each candidate in order so the message is actionable
 *   (users see exactly where to install the CLI).
 * - `VendorCliVersionMismatchError` — a binary was found, but its reported
 *   version fell outside `descriptor.versionProbe.constraint`. Throws
 *   BEFORE spawn so a downstream "the SDK exploded weirdly" trail ends
 *   here.
 *
 * Both extend `AdapterError`, so the CLI's code→exit mapping still fires
 * and downstream sinks can discriminate on the stable `.code` string.
 *
 * ### Testability
 *
 * Every I/O seam is injectable: `existsImpl` / `whichImpl` for candidate
 * resolution, `versionProbeRunner` for the semver probe, `lastChance` for
 * the Claude sidecar bootstrap. Production defaults hit `fs.existsSync` +
 * `Bun.which` (with a PATH-scan fallback for Node-under-Vitest).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { AdapterError } from "./errors.ts";

/**
 * Known vendor names. Kept aligned with the CLI's `AdapterName` union
 * (`apps/cli/src/services/adapters.ts`) — if you add an adapter there, add
 * it here too. The `VENDOR_NAMES` tuple drives the exhaustiveness check in
 * `vendor-cli-registry.ts`.
 */
export const VENDOR_NAMES = [
  "echo",
  "claude",
  "codex",
  "cursor",
  "gemini",
  "amp",
  "opencode",
  "pi",
] as const;

export type VendorName = (typeof VENDOR_NAMES)[number];

/**
 * A single candidate location to probe for the vendor binary.
 *
 * - `absolute` — a fully-qualified path (e.g. `/opt/homebrew/bin/claude`).
 * - `homeRelative` — segments joined onto `os.homedir()`. Use for npm /
 *   bun / pnpm globals (`.bun/install/global/node_modules/…/bin/<bin>`),
 *   XDG paths, and vendor-specific install locations under `$HOME`.
 * - `pathLookup` — defer to `Bun.which(binaryName)` / PATH scan. Always
 *   last in the candidate list for adapters that want a PATH fallback.
 */
export type CandidateSpec =
  | { readonly kind: "absolute"; readonly path: string }
  | { readonly kind: "homeRelative"; readonly segments: readonly string[] }
  | { readonly kind: "pathLookup" };

/** Result of running `descriptor.versionProbe.parse(stdout)`. */
export type ParsedVersion = string | null;

/**
 * Optional per-adapter version probe. If set and a candidate resolves, the
 * resolver runs `<candidate> <args>`, passes stdout through `parse`, and
 * checks the parsed version against `constraint` (subset of node-semver
 * ranges — see `matchesVersionConstraint` below).
 */
export interface VendorCliVersionProbe {
  readonly args: readonly string[];
  readonly parse: (stdout: string) => ParsedVersion;
  readonly constraint?: string;
}

/**
 * Optional per-adapter auth probe. Not executed by the resolver today —
 * reserved for a future `shamu doctor --resolve-clis --deep` switch that
 * verifies the CLI is not only installed but logged in. Kept in the shape
 * so adapter authors can declare intent now.
 */
export interface VendorCliAuthProbe {
  readonly args: readonly string[];
  readonly success: (result: VersionProbeResult) => boolean;
}

/**
 * Per-adapter data bundle. Declared in each adapter package's
 * `vendor-cli-descriptor.ts` and aggregated in `vendor-cli-registry.ts`.
 *
 * Pure data — no function calls at import time, no side effects.
 */
export interface VendorCliDescriptor {
  readonly adapter: VendorName;
  /**
   * Name(s) the binary is known by. First entry is used for `pathLookup`
   * candidates. Extra entries are informational — surfaced in doctor
   * output and in the error message when every candidate misses.
   */
  readonly binaryNames: readonly string[];
  readonly candidates: readonly CandidateSpec[];
  readonly versionProbe?: VendorCliVersionProbe;
  readonly authProbe?: VendorCliAuthProbe;
  /**
   * User-facing one-liner that explains how to install the CLI. Appended
   * to `VendorCliNotFoundError.message` so operators see the canonical
   * install command without having to read the descriptor source.
   */
  readonly installHint?: string;
}

/** Everything the resolver needs per call. Minimizes surface for tests. */
export interface VendorCliResolverInput {
  readonly adapter: VendorName;
  /** Explicit CLI flag value (e.g. `--claude-cli /foo`). Highest priority. */
  readonly explicit?: string | undefined;
  /** Env snapshot. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Per-adapter entry pulled from `shamu.config.ts`. */
  readonly configEntry?: {
    readonly cliPath?: string;
    readonly cliVersionConstraint?: string;
  };
  readonly descriptor: VendorCliDescriptor;
  /** Test seam — defaults to `fs.existsSync`. */
  readonly existsImpl?: (path: string) => boolean;
  /** Test seam — defaults to `Bun.which`, falling back to a PATH scan. */
  readonly whichImpl?: (bin: string) => string | null;
  /** Test seam — defaults to a `Bun.spawn`-backed runner. */
  readonly versionProbeRunner?: VersionProbeRunner;
  /**
   * Last-chance candidate. If the entire chain misses, the resolver
   * awaits `lastChance()` and, when it returns a non-null path, returns
   * that path with `source: "lastChance"`. Used for Claude's sidecar
   * bootstrap: we don't want to probe it in the common "CLI is on PATH"
   * case because it may hit the network.
   */
  readonly lastChance?: () => Promise<string | null>;
  /**
   * Optional hook invoked when `lastChance` throws. The resolver
   * swallows the error and falls back to `VendorCliNotFoundError`; the
   * hook lets the caller surface the sidecar error as a diag without
   * failing the whole run.
   */
  readonly onLastChanceError?: (err: unknown) => void;
}

/** One row in the `attempts` trace. */
export interface VendorCliResolverAttempt {
  readonly kind:
    | "explicit"
    | "env"
    | "config"
    | "absolute"
    | "homeRelative"
    | "pathLookup"
    | "lastChance";
  readonly path?: string;
  readonly outcome: "found" | "missing" | "skipped";
  /** When `outcome: "missing"`, why (human-readable). */
  readonly detail?: string;
}

export type VendorCliResolverSource =
  | "explicit"
  | "env"
  | "config"
  | "candidate"
  | "pathLookup"
  | "lastChance"
  | "unused";

export interface VendorCliResolverResult {
  /**
   * Absolute path to the selected CLI binary. Empty string iff the
   * adapter has no CLI (echo); callers should branch on `source` when
   * deciding whether to pass `SpawnOpts.vendorCliPath`.
   */
  readonly path: string;
  readonly source: VendorCliResolverSource;
  readonly version?: string;
  readonly attempts: readonly VendorCliResolverAttempt[];
}

/** Canonical env-var name derived from the vendor: `gemini → GEMINI_CLI_PATH`. */
export function envVarFor(vendor: VendorName): string {
  return `${vendor.toUpperCase()}_CLI_PATH`;
}

/**
 * Descriptor for adapters with no vendor CLI (today: just echo). The
 * resolver short-circuits on `binaryNames.length === 0`.
 */
export function isNoBinaryDescriptor(descriptor: VendorCliDescriptor): boolean {
  return descriptor.binaryNames.length === 0 && descriptor.candidates.length === 0;
}

/** Result returned by `VersionProbeRunner`. */
export interface VersionProbeResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type VersionProbeRunner = (input: {
  readonly binary: string;
  readonly args: readonly string[];
}) => Promise<VersionProbeResult>;

/** Thrown when every source in the precedence chain returned "missing". */
export class VendorCliNotFoundError extends AdapterError {
  public readonly code = "vendor_cli_not_found" as const;
  public readonly adapter: VendorName;
  public readonly attempts: readonly VendorCliResolverAttempt[];

  constructor(adapter: VendorName, attempts: readonly VendorCliResolverAttempt[], hint?: string) {
    const checked = attempts
      .filter((a) => a.outcome === "missing" && typeof a.path === "string" && a.path.length > 0)
      .map((a) => `  - ${a.path}`)
      .join("\n");
    const lines = [
      `Vendor CLI for '${adapter}' not found.`,
      checked.length > 0 ? `Checked:\n${checked}` : undefined,
      hint ? `Hint: ${hint}` : undefined,
    ].filter((s): s is string => typeof s === "string");
    super(lines.join("\n"));
    this.adapter = adapter;
    this.attempts = attempts;
  }
}

/** Thrown when a found binary fails its semver probe. */
export class VendorCliVersionMismatchError extends AdapterError {
  public readonly code = "vendor_cli_version_mismatch" as const;
  public readonly adapter: VendorName;
  public readonly path: string;
  public readonly version: string | null;
  public readonly constraint: string;

  constructor(adapter: VendorName, path: string, version: string | null, constraint: string) {
    super(
      `Vendor CLI for '${adapter}' at ${path} reports version ${version ?? "unknown"} ` +
        `which does not satisfy constraint '${constraint}'.`,
    );
    this.adapter = adapter;
    this.path = path;
    this.version = version;
    this.constraint = constraint;
  }
}

/**
 * Resolve the CLI binary path for a single adapter.
 *
 * Never spawns anything unless `descriptor.versionProbe` is set and a
 * candidate matched. Never hits the network unless `lastChance` does.
 */
export async function resolveVendorCli(
  input: VendorCliResolverInput,
): Promise<VendorCliResolverResult> {
  const { descriptor } = input;
  const attempts: VendorCliResolverAttempt[] = [];
  const env = input.env ?? process.env;
  const existsImpl = input.existsImpl ?? existsSync;
  const whichImpl = input.whichImpl ?? defaultWhich;

  // 0. No-binary adapters (echo). Short-circuit with an `unused` source.
  if (isNoBinaryDescriptor(descriptor)) {
    return { path: "", source: "unused", attempts: [] };
  }

  // 1. Explicit.
  if (input.explicit && input.explicit.length > 0) {
    if (existsImpl(input.explicit)) {
      attempts.push({ kind: "explicit", path: input.explicit, outcome: "found" });
      const verified = await verifyVersion({ ...input, path: input.explicit, attempts });
      return {
        path: input.explicit,
        source: "explicit",
        ...(verified.version !== undefined ? { version: verified.version } : {}),
        attempts,
      };
    }
    attempts.push({
      kind: "explicit",
      path: input.explicit,
      outcome: "missing",
      detail: "file does not exist",
    });
    throw new VendorCliNotFoundError(descriptor.adapter, attempts, descriptor.installHint);
  }
  attempts.push({ kind: "explicit", outcome: "skipped", detail: "no --<vendor>-cli flag" });

  // 2. Env var.
  const envKey = envVarFor(descriptor.adapter);
  const envPath = env[envKey];
  if (typeof envPath === "string" && envPath.length > 0) {
    if (existsImpl(envPath)) {
      attempts.push({ kind: "env", path: envPath, outcome: "found" });
      const verified = await verifyVersion({ ...input, path: envPath, attempts });
      return {
        path: envPath,
        source: "env",
        ...(verified.version !== undefined ? { version: verified.version } : {}),
        attempts,
      };
    }
    attempts.push({
      kind: "env",
      path: envPath,
      outcome: "missing",
      detail: `${envKey} points to a non-existent file`,
    });
    throw new VendorCliNotFoundError(descriptor.adapter, attempts, descriptor.installHint);
  }
  attempts.push({ kind: "env", outcome: "skipped", detail: `${envKey} unset` });

  // 3. Config entry.
  const configPath = input.configEntry?.cliPath;
  if (typeof configPath === "string" && configPath.length > 0) {
    if (existsImpl(configPath)) {
      attempts.push({ kind: "config", path: configPath, outcome: "found" });
      const verified = await verifyVersion({ ...input, path: configPath, attempts });
      return {
        path: configPath,
        source: "config",
        ...(verified.version !== undefined ? { version: verified.version } : {}),
        attempts,
      };
    }
    attempts.push({
      kind: "config",
      path: configPath,
      outcome: "missing",
      detail: "shamu.config.ts cliPath does not exist",
    });
    throw new VendorCliNotFoundError(descriptor.adapter, attempts, descriptor.installHint);
  }
  attempts.push({ kind: "config", outcome: "skipped", detail: "no config.adapters entry" });

  // 4. Descriptor candidates.
  for (const candidate of descriptor.candidates) {
    if (candidate.kind === "pathLookup") {
      const binName = descriptor.binaryNames[0] ?? descriptor.adapter;
      const onPath = whichImpl(binName);
      if (onPath && onPath.length > 0 && existsImpl(onPath)) {
        attempts.push({ kind: "pathLookup", path: onPath, outcome: "found" });
        const verified = await verifyVersion({ ...input, path: onPath, attempts });
        return {
          path: onPath,
          source: "pathLookup",
          ...(verified.version !== undefined ? { version: verified.version } : {}),
          attempts,
        };
      }
      attempts.push({
        kind: "pathLookup",
        outcome: "missing",
        detail: `${binName} not on PATH`,
      });
      continue;
    }

    const candidatePath =
      candidate.kind === "absolute" ? candidate.path : join(homedir(), ...candidate.segments);

    if (existsImpl(candidatePath)) {
      attempts.push({
        kind: candidate.kind,
        path: candidatePath,
        outcome: "found",
      });
      const verified = await verifyVersion({ ...input, path: candidatePath, attempts });
      return {
        path: candidatePath,
        source: "candidate",
        ...(verified.version !== undefined ? { version: verified.version } : {}),
        attempts,
      };
    }
    attempts.push({
      kind: candidate.kind,
      path: candidatePath,
      outcome: "missing",
    });
  }

  // 5. Last-chance hook (Claude sidecar).
  if (input.lastChance) {
    try {
      const lastChancePath = await input.lastChance();
      if (lastChancePath && lastChancePath.length > 0) {
        if (existsImpl(lastChancePath)) {
          attempts.push({ kind: "lastChance", path: lastChancePath, outcome: "found" });
          const verified = await verifyVersion({
            ...input,
            path: lastChancePath,
            attempts,
          });
          return {
            path: lastChancePath,
            source: "lastChance",
            ...(verified.version !== undefined ? { version: verified.version } : {}),
            attempts,
          };
        }
        attempts.push({
          kind: "lastChance",
          path: lastChancePath,
          outcome: "missing",
          detail: "lastChance returned a path that does not exist",
        });
      } else {
        attempts.push({
          kind: "lastChance",
          outcome: "missing",
          detail: "lastChance returned null",
        });
      }
    } catch (err) {
      input.onLastChanceError?.(err);
      attempts.push({
        kind: "lastChance",
        outcome: "missing",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new VendorCliNotFoundError(descriptor.adapter, attempts, descriptor.installHint);
}

/**
 * Default `which` — prefers `Bun.which` (available under Bun + as a test
 * runner), falls back to a simple PATH scan so the resolver keeps working
 * under Vitest's Node worker.
 */
function defaultWhich(bin: string): string | null {
  const bunGlobal = (globalThis as { Bun?: { which?: (b: string) => string | null } }).Bun;
  if (bunGlobal?.which) {
    try {
      const found = bunGlobal.which(bin);
      if (typeof found === "string" && found.length > 0) return found;
    } catch {
      // fall through to PATH scan
    }
  }
  const pathEnv = process.env.PATH;
  if (!pathEnv) return null;
  for (const segment of pathEnv.split(delimiter)) {
    if (segment.length === 0) continue;
    const candidate = join(segment, bin);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * If the descriptor declares a version probe, run it and validate the
 * result against `descriptor.versionProbe.constraint` (or, when set,
 * `configEntry.cliVersionConstraint` — the config wins so operators can
 * tighten the range without forking the adapter).
 *
 * Returns `{ version }` on success. Throws `VendorCliVersionMismatchError`
 * when the parsed version falls outside the constraint. No-op when no
 * probe is declared.
 */
async function verifyVersion(params: {
  readonly descriptor: VendorCliDescriptor;
  readonly configEntry?: { readonly cliVersionConstraint?: string };
  readonly versionProbeRunner?: VersionProbeRunner;
  readonly path: string;
  readonly attempts: VendorCliResolverAttempt[];
}): Promise<{ version?: string }> {
  const { descriptor, path } = params;
  const probe = descriptor.versionProbe;
  if (!probe) return {};

  const runner = params.versionProbeRunner;
  if (!runner) return {};

  let result: VersionProbeResult;
  try {
    result = await runner({ binary: path, args: probe.args });
  } catch {
    // Treat probe failure as "couldn't determine version" — don't fail
    // resolution; the downstream SDK will surface any real spawn issue.
    return {};
  }

  const parsed = probe.parse(result.stdout) ?? probe.parse(result.stderr);
  const constraint = params.configEntry?.cliVersionConstraint ?? probe.constraint;
  if (constraint && constraint.length > 0) {
    if (!matchesVersionConstraint(parsed, constraint)) {
      throw new VendorCliVersionMismatchError(descriptor.adapter, path, parsed, constraint);
    }
  }
  return parsed ? { version: parsed } : {};
}

/**
 * Minimal node-semver-ish range matcher. Supports the common forms we see
 * in vendor CLI docs: `>=1.2.3`, `<2.0.0`, `^1.2.3`, `~1.2.3`, exact
 * (`1.2.3`), and compound (`>=1.0.0 <2.0.0`). Returns `false` for
 * unparseable input — err on the side of "please set a real constraint"
 * rather than silently accept.
 *
 * Kept inline so `@shamu/adapters-base` stays dep-free. If a future
 * descriptor needs full semver semantics (build metadata, prerelease
 * ordering), swap this out for `semver` and pin the exact version.
 */
export function matchesVersionConstraint(version: string | null, constraint: string): boolean {
  if (!version) return false;
  const parts = constraint
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return true;
  for (const part of parts) {
    if (!matchesSingleRange(version, part)) return false;
  }
  return true;
}

function matchesSingleRange(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (!v) return false;
  if (range.startsWith(">=")) return compareSemver(v, parseSemver(range.slice(2))) >= 0;
  if (range.startsWith("<=")) return compareSemver(v, parseSemver(range.slice(2))) <= 0;
  if (range.startsWith(">")) return compareSemver(v, parseSemver(range.slice(1))) > 0;
  if (range.startsWith("<")) return compareSemver(v, parseSemver(range.slice(1))) < 0;
  if (range.startsWith("=")) return compareSemver(v, parseSemver(range.slice(1))) === 0;
  if (range.startsWith("^")) {
    const base = parseSemver(range.slice(1));
    if (!base) return false;
    if (base[0] === 0) {
      if (base[1] === 0) {
        // ^0.0.x → only that exact patch
        return compareSemver(v, base) === 0;
      }
      // ^0.x.y → >=0.x.y <0.(x+1).0
      return compareSemver(v, base) >= 0 && compareSemver(v, [0, base[1] + 1, 0]) < 0;
    }
    // ^x.y.z → >=x.y.z <(x+1).0.0
    return compareSemver(v, base) >= 0 && compareSemver(v, [base[0] + 1, 0, 0]) < 0;
  }
  if (range.startsWith("~")) {
    const base = parseSemver(range.slice(1));
    if (!base) return false;
    // ~x.y.z → >=x.y.z <x.(y+1).0
    return compareSemver(v, base) >= 0 && compareSemver(v, [base[0], base[1] + 1, 0]) < 0;
  }
  // Exact.
  const exact = parseSemver(range);
  if (!exact) return false;
  return compareSemver(v, exact) === 0;
}

function parseSemver(input: string | null | undefined): [number, number, number] | null {
  if (!input) return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(input);
  if (!match?.[1] || match[2] === undefined || match[3] === undefined) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(
  a: readonly [number, number, number] | null,
  b: readonly [number, number, number] | null,
): number {
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
