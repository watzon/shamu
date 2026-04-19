#!/usr/bin/env bun
/**
 * Generate `docs/phase-7/capability-matrix.md` from each adapter's
 * frozen `capabilities.json`.
 *
 * Phase 7.G deliverable 3. Idempotent — re-running against an unchanged
 * set of capabilities produces byte-identical output, so CI can compare
 * the generated file against the committed one to catch drift.
 *
 * Resolution strategy:
 *   The script runs from the repo root. It reads each adapter's
 *   `capabilities.json` by resolving the workspace's `exports` map:
 *   `require.resolve("@shamu/adapter-<name>/capabilities.json")`. This
 *   keeps the generator from hard-coding filesystem layout — the adapter
 *   `package.json` is authoritative for where the manifest lives.
 *
 *   We rely on Bun's CommonJS `require` for resolution rather than ESM
 *   JSON-import assertions (`import x from "...json" with {type:"json"}`)
 *   because the script sits outside any workspace package and therefore
 *   can't rely on workspace link resolution in the root `node_modules/`
 *   (symlinks exist only under each consuming package's local
 *   `node_modules/`). The `createRequire(import.meta.url)` call plus
 *   the one-package hop via an anchor module resolves through the
 *   adapter packages' own dep graphs.
 *
 * Usage:
 *   bun scripts/generate-capability-matrix.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { freezeCapabilities } from "../packages/adapters/base/src/capabilities.ts";
import {
  type AdapterCapabilityEntry,
  buildCapabilityMatrix,
  renderCapabilityMatrixMarkdown,
} from "../packages/adapters/base/src/capability-matrix.ts";

/** Adapter rows, ordered by phase landing date. */
const VENDOR_ORDER: readonly string[] = [
  "echo",
  "claude",
  "codex",
  "opencode",
  "cursor",
  "gemini",
  "amp",
  "pi",
];

/**
 * Locate each adapter's `capabilities.json` by walking the repo's
 * `packages/adapters/<name>/src/capabilities.json` layout. Deliberately
 * filesystem-native: every adapter package.json under
 * `packages/adapters/*` already exposes this path via its `exports`
 * map, so the location is a structural invariant of the monorepo.
 */
function readCapabilitiesFor(repoRoot: string, vendor: string): unknown {
  const manifestPath = resolve(
    repoRoot,
    "packages",
    "adapters",
    vendor,
    "src",
    "capabilities.json",
  );
  const text = readFileSync(manifestPath, "utf8");
  return JSON.parse(text);
}

const BANNER = [
  "<!--",
  "  GENERATED FILE — DO NOT EDIT.",
  "",
  "  Source of truth: each adapter's `src/capabilities.json` manifest.",
  "  Regenerate with:",
  "",
  "    bun scripts/generate-capability-matrix.ts",
  "",
  "  The generator consumes each adapter's `capabilities.json` from",
  "  `packages/adapters/<name>/src/capabilities.json` and runs",
  "  `buildCapabilityMatrix` + `renderCapabilityMatrixMarkdown` from",
  "  `@shamu/adapters-base/capability-matrix`.",
  "-->",
].join("\n");

const INTRO = [
  "# Adapter capability matrix",
  "",
  "Every Shamu vendor adapter ships a frozen `capabilities.json` manifest",
  "(PLAN.md § 1 / G8 — capabilities are declared at build time and",
  "immutable at runtime). The shared contract suite keys scenario skip /",
  "run decisions off these fields, and the matrix below is the canonical",
  '"which adapter supports what" view.',
  "",
  "## Schema",
  "",
  "The schema lives in `packages/shared/src/capabilities.ts`. The columns",
  "used below come in two flavors:",
  "",
  "- **Feature parity** — boolean columns derived from the",
  "  `CapabilityFeature` predicates in",
  "  `packages/adapters/base/src/capabilities.ts`. These are the",
  "  features the contract suite's `scenario.requires` list keys off;",
  "  a `no` here means the adapter opts that scenario out of its",
  "  contract run.",
  "- **Enum / detail fields** — the underlying union types. They show",
  '  _how_ the adapter satisfies a capability (e.g., `interrupt: "cooperative"`',
  '  vs `"hard"` vs `"none"`), which matters when picking a vendor for',
  "  a specific workflow but isn't reducible to a single bool.",
  "",
  "## Matrix",
  "",
].join("\n");

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..");

  const entries: AdapterCapabilityEntry[] = VENDOR_ORDER.map((vendor) => ({
    vendor,
    capabilities: freezeCapabilities(readCapabilitiesFor(repoRoot, vendor)),
  }));

  const matrix = buildCapabilityMatrix(entries);
  const table = renderCapabilityMatrixMarkdown(matrix);

  const outPath = resolve(repoRoot, "docs", "phase-7", "capability-matrix.md");

  const content = [BANNER, "", INTRO, table, ""].join("\n");
  writeFileSync(outPath, content, "utf8");
  stdout.write(`Wrote ${outPath} (${entries.length} adapters)\n`);
}

main();
