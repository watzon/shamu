#!/usr/bin/env bun

/**
 * `scripts/build-release.ts` — produce a reproducible single-binary build of
 * the `shamu` CLI via `bun build --compile`.
 *
 * Phase 8.C Track 8.C.2 deliverable. Ships the scripts + plumbing; a future
 * release-automation PR drives the actual artifact upload.
 *
 * Scope:
 *   - One subprocess per target (`bun-darwin-arm64`, `bun-linux-x64`).
 *   - Writes an executable binary and a `<binary>.sha256` sidecar beside it.
 *   - Emits NDJSON progress events so a CI driver (or a human) can parse the
 *     stream: `{ kind: "build-start", target }` / `{ kind: "build-done",
 *     target, path, sha256, bytes }`.
 *   - Non-zero exit + stderr diagnostic on any target failure. Partial output
 *     from successful targets is preserved (no implicit cleanup) so a caller
 *     can retry only the failing target.
 *
 * Phase 0.A (`docs/phase-0/bun-compat.md` Test 3) confirmed the
 * `bun build --compile` story works for Shamu's CLI shape on darwin-arm64;
 * this script wires that into a release-friendly driver. The Claude 200MB
 * sidecar cannot live inside the compiled binary — see
 * `packages/adapters/claude/src/sidecar.ts` for the first-run bootstrap that
 * fetches + verifies it at runtime.
 *
 * Usage:
 *   bun scripts/build-release.ts
 *   bun scripts/build-release.ts --target=darwin-arm64
 *   bun scripts/build-release.ts --target=linux-x64
 *   bun scripts/build-release.ts --target=all --outdir=./dist/release
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch as hostArch, platform as hostPlatform } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";

// --- target resolution ----------------------------------------------------

export type BuildTarget = "darwin-arm64" | "linux-x64";

const ALL_TARGETS: readonly BuildTarget[] = ["darwin-arm64", "linux-x64"];

export function isBuildTarget(value: string): value is BuildTarget {
  return (ALL_TARGETS as readonly string[]).includes(value);
}

/**
 * Resolve the host's native build target. Called when the CLI is invoked
 * without `--target` and when the user passes `--target=host`. We narrow
 * `os.arch()` output because Node returns aliases (`arm64`, `x64`) that
 * don't line up 1:1 with Bun's `--target` slugs (`bun-darwin-arm64`,
 * `bun-linux-x64`).
 */
export function resolveHostTarget(): BuildTarget {
  const plat = hostPlatform();
  const arch = hostArch();
  if (plat === "darwin" && arch === "arm64") return "darwin-arm64";
  if (plat === "linux" && arch === "x64") return "linux-x64";
  throw new Error(
    `build-release: no supported target for host ${plat}-${arch}; pass --target=darwin-arm64 or --target=linux-x64 explicitly`,
  );
}

// --- arg parsing ----------------------------------------------------------

export interface CliArgs {
  readonly targets: readonly BuildTarget[];
  readonly outdir: string;
  readonly entrypoint: string;
  readonly repoRoot: string;
}

export function parseArgs(argv: readonly string[], opts: { readonly repoRoot: string }): CliArgs {
  let rawTarget: string | undefined;
  let outdir = "./dist/release";
  let entrypoint = "apps/cli/src/index.ts";
  for (const arg of argv) {
    if (arg.startsWith("--target=")) {
      rawTarget = arg.slice("--target=".length);
      continue;
    }
    if (arg.startsWith("--outdir=")) {
      outdir = arg.slice("--outdir=".length);
      continue;
    }
    if (arg.startsWith("--entrypoint=")) {
      entrypoint = arg.slice("--entrypoint=".length);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      stdout.write(USAGE);
      exit(0);
    }
    throw new Error(`build-release: unknown argument '${arg}' (see --help)`);
  }
  const targets = resolveTargets(rawTarget);
  const absOutdir = isAbsolute(outdir) ? outdir : resolve(opts.repoRoot, outdir);
  const absEntrypoint = isAbsolute(entrypoint) ? entrypoint : resolve(opts.repoRoot, entrypoint);
  return {
    targets,
    outdir: absOutdir,
    entrypoint: absEntrypoint,
    repoRoot: opts.repoRoot,
  };
}

const USAGE = `Usage: bun scripts/build-release.ts [options]

Options:
  --target=<t>      Build target: darwin-arm64 | linux-x64 | host | all
                    (default: host)
  --outdir=<path>   Output directory (default: ./dist/release)
  --entrypoint=<p>  Entry TS source (default: apps/cli/src/index.ts)
  --help, -h        Show this message
`;

function resolveTargets(raw: string | undefined): readonly BuildTarget[] {
  if (raw === undefined || raw === "host") return [resolveHostTarget()];
  if (raw === "all") return ALL_TARGETS;
  if (!isBuildTarget(raw)) {
    throw new Error(
      `build-release: invalid --target '${raw}'; expected one of ${ALL_TARGETS.join(", ")} | host | all`,
    );
  }
  return [raw];
}

// --- build invocation -----------------------------------------------------

export interface BuildResult {
  readonly target: BuildTarget;
  readonly outfile: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * Synchronously run `bun build --compile --target=bun-<target>` for one
 * target and verify the output is a usable executable. Throws with a clear
 * diagnostic on any failure.
 */
export function buildOneTarget(input: {
  readonly target: BuildTarget;
  readonly outdir: string;
  readonly entrypoint: string;
  readonly repoRoot: string;
  readonly emit?: (event: BuildEvent) => void;
}): BuildResult {
  const { target, outdir, entrypoint, repoRoot } = input;
  const emit = input.emit ?? emitNdjson;
  emit({ kind: "build-start", target });
  mkdirSync(outdir, { recursive: true });
  const outfile = resolve(outdir, `shamu-${target}`);
  const bunTarget = `bun-${target}`;
  const result = spawnSync(
    "bun",
    ["build", "--compile", `--target=${bunTarget}`, `--outfile=${outfile}`, entrypoint],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  );
  if (result.error) {
    throw new Error(
      `build-release: failed to invoke bun for target=${target}: ${result.error.message}`,
    );
  }
  if (typeof result.status !== "number" || result.status !== 0) {
    const stderrText = result.stderr?.toString() ?? "";
    throw new Error(
      `build-release: bun build --compile failed for target=${target} ` +
        `(exit ${result.status ?? "null"}): ${stderrText.trim() || "no stderr"}`,
    );
  }
  // Verify the outfile shape before computing the SHA (clearer failure mode
  // than getting "file not found" from readFileSync below).
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(outfile);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `build-release: target=${target} succeeded per bun exit=0 but output missing at ${outfile}: ${message}`,
    );
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(
      `build-release: target=${target} produced invalid output at ${outfile} (size=${stat.size})`,
    );
  }
  // `bun build --compile` sets the exec bit on darwin but we re-set it here
  // for belt-and-suspenders on linux, where some CI matrices drop the bit
  // when artifacts round-trip through zip archives.
  chmodSync(outfile, 0o755);
  const buf = readFileSync(outfile);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  writeFileSync(`${outfile}.sha256`, `${sha256}  shamu-${target}\n`, "utf8");
  const built: BuildResult = {
    target,
    outfile,
    sha256,
    bytes: stat.size,
  };
  emit({
    kind: "build-done",
    target,
    path: outfile,
    sha256,
    bytes: stat.size,
  });
  return built;
}

// --- NDJSON progress emitter ---------------------------------------------

export type BuildEvent =
  | { readonly kind: "build-start"; readonly target: BuildTarget }
  | {
      readonly kind: "build-done";
      readonly target: BuildTarget;
      readonly path: string;
      readonly sha256: string;
      readonly bytes: number;
    };

function emitNdjson(event: BuildEvent): void {
  stdout.write(`${JSON.stringify(event)}\n`);
}

// --- CLI entry ------------------------------------------------------------

function resolveRepoRoot(): string {
  // `scripts/` sits under the repo root. `fileURLToPath` resolves the
  // compiled-script URL to a filesystem path; `dirname` twice gives the
  // parent directory (repo root) regardless of whether the caller invoked
  // the script via its absolute path, a relative path, or `bun run`.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..");
}

async function main(): Promise<number> {
  const repoRoot = resolveRepoRoot();
  let parsed: CliArgs;
  try {
    parsed = parseArgs(process.argv.slice(2), { repoRoot });
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const { targets, outdir, entrypoint } = parsed;
  for (const target of targets) {
    try {
      buildOneTarget({ target, outdir, entrypoint, repoRoot });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stderr.write(`${message}\n`);
      return 1;
    }
  }
  return 0;
}

// Only run when invoked directly (not when imported by a test).
const isEntry = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isEntry) {
  void main().then((code) => exit(code));
}
