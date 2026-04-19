/**
 * Capability matrix — adapter parity overview.
 *
 * Phase 7.G: the canonical "which adapter supports what" view. Takes a
 * list of `{ vendor, capabilities }` entries sourced from each adapter's
 * frozen `capabilities.json` and produces:
 *
 * 1. A structured matrix (`CapabilityMatrix`) with rows = adapters,
 *    columns = every `CapabilityFeature` the contract suite keys off
 *    plus the raw enum fields (permissionModes / mcp / sandboxing /
 *    interrupt / patchVisibility / usageReporting / costReporting /
 *    streaming). Pure data — callers decide how to render.
 * 2. A Markdown renderer (`renderCapabilityMatrixMarkdown`) that turns
 *    the structured matrix into a human-readable table. Used by the
 *    `scripts/generate-capability-matrix.ts` generator.
 *
 * Design notes:
 * - Pure + deterministic: identical input always yields identical
 *   output. No wall-clock reads; no reliance on iteration order of
 *   unordered sets. Permission-mode columns sort deterministically.
 * - Allocation-light: the renderer walks each row once and emits a
 *   single string; no intermediate per-cell arrays.
 * - The list of `CapabilityFeature`s is imported from
 *   `./capabilities.ts` so a schema change in one place propagates.
 */

import type { Capabilities, PermissionMode } from "@shamu/shared/capabilities";
import { type CapabilityFeature, supportsCapability } from "./capabilities.ts";

/** One adapter's capabilities entry, as consumed by the matrix generator. */
export interface AdapterCapabilityEntry {
  readonly vendor: string;
  readonly capabilities: Capabilities;
}

/**
 * The ordered list of `CapabilityFeature`s that become boolean columns.
 * Deliberately hand-rolled (rather than derived from `CapabilityFeature`)
 * so ordering in the rendered matrix is stable and review-friendly.
 *
 * Keep in sync with `CapabilityFeature` in `./capabilities.ts`.
 */
export const CAPABILITY_FEATURE_COLUMNS: readonly CapabilityFeature[] = Object.freeze([
  "resume",
  "fork",
  "interrupt",
  "customTools",
  "patchEvents",
  "streamingEvents",
  "usageReporting",
  "costReporting",
]);

/** Canonical ordering of `PermissionMode` for stable column rendering. */
export const PERMISSION_MODE_ORDER: readonly PermissionMode[] = Object.freeze([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
]);

/**
 * One row of the matrix — a single adapter, with every column resolved.
 *
 * `features` is a boolean-per-CapabilityFeature map; `enums` captures the
 * raw enum/union fields from `Capabilities` so the renderer can expose
 * "how does it interrupt?" (cooperative / hard / none) rather than a
 * reductive boolean.
 */
export interface CapabilityMatrixRow {
  readonly vendor: string;
  readonly features: Readonly<Record<CapabilityFeature, boolean>>;
  readonly enums: {
    readonly interrupt: Capabilities["interrupt"];
    readonly mcp: Capabilities["mcp"];
    readonly patchVisibility: Capabilities["patchVisibility"];
    readonly usageReporting: Capabilities["usageReporting"];
    readonly costReporting: Capabilities["costReporting"];
    readonly sandboxing: Capabilities["sandboxing"];
    readonly streaming: Capabilities["streaming"];
  };
  /** Declared permission modes, sorted by `PERMISSION_MODE_ORDER`. */
  readonly permissionModes: readonly PermissionMode[];
}

/** The whole structured matrix. */
export interface CapabilityMatrix {
  readonly rows: readonly CapabilityMatrixRow[];
  /** Frozen reference to the column order used to render the matrix. */
  readonly featureColumns: readonly CapabilityFeature[];
}

/**
 * Build a structured `CapabilityMatrix` from a list of adapter entries.
 *
 * Vendor ordering is preserved from the input — callers are expected to
 * present adapters in a meaningful order (e.g., stable phase order).
 * Permission modes per row are re-ordered via `PERMISSION_MODE_ORDER`
 * so visually scanning across rows is predictable.
 */
export function buildCapabilityMatrix(
  entries: readonly AdapterCapabilityEntry[],
): CapabilityMatrix {
  const rows = entries.map((entry): CapabilityMatrixRow => {
    const features = {} as Record<CapabilityFeature, boolean>;
    for (const feature of CAPABILITY_FEATURE_COLUMNS) {
      features[feature] = supportsCapability(entry.capabilities, feature);
    }
    const permissionModes = PERMISSION_MODE_ORDER.filter((mode) =>
      entry.capabilities.permissionModes.includes(mode),
    );
    return {
      vendor: entry.vendor,
      features: Object.freeze(features),
      enums: Object.freeze({
        interrupt: entry.capabilities.interrupt,
        mcp: entry.capabilities.mcp,
        patchVisibility: entry.capabilities.patchVisibility,
        usageReporting: entry.capabilities.usageReporting,
        costReporting: entry.capabilities.costReporting,
        sandboxing: entry.capabilities.sandboxing,
        streaming: entry.capabilities.streaming,
      }),
      permissionModes: Object.freeze(permissionModes),
    };
  });
  return Object.freeze({
    rows: Object.freeze(rows),
    featureColumns: CAPABILITY_FEATURE_COLUMNS,
  });
}

/** Markdown cell text for a boolean feature column. */
function boolCell(value: boolean): string {
  return value ? "yes" : "no";
}

/** Escape pipe characters so they don't break the Markdown table. */
function mdEscape(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/** Join a list of permission modes as a single Markdown cell. */
function permissionModesCell(modes: readonly PermissionMode[]): string {
  if (modes.length === 0) return "(none)";
  return modes.join(", ");
}

/**
 * Render a `CapabilityMatrix` as two Markdown tables:
 *
 * 1. Feature-boolean matrix — one row per adapter, one column per
 *    `CapabilityFeature`. Quick visual scan of parity.
 * 2. Enum/detail matrix — interrupt / mcp / permission modes /
 *    patchVisibility / usageReporting / costReporting / sandboxing /
 *    streaming. Answers "how does this adapter do X" beyond the bool.
 *
 * The output is deterministic for a given input.
 */
export function renderCapabilityMatrixMarkdown(matrix: CapabilityMatrix): string {
  const lines: string[] = [];

  // --- Table 1: feature parity (boolean grid).
  lines.push("### Feature parity");
  lines.push("");
  const featureHeader = ["Adapter", ...matrix.featureColumns];
  lines.push(`| ${featureHeader.join(" | ")} |`);
  lines.push(`| ${featureHeader.map(() => "---").join(" | ")} |`);
  for (const row of matrix.rows) {
    const cells = [
      mdEscape(row.vendor),
      ...matrix.featureColumns.map((feature) => boolCell(row.features[feature])),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");

  // --- Table 2: enum/detail fields.
  lines.push("### Enum / detail fields");
  lines.push("");
  const enumHeader = [
    "Adapter",
    "interrupt",
    "mcp",
    "permissionModes",
    "patchVisibility",
    "usageReporting",
    "costReporting",
    "sandboxing",
    "streaming",
  ];
  lines.push(`| ${enumHeader.join(" | ")} |`);
  lines.push(`| ${enumHeader.map(() => "---").join(" | ")} |`);
  for (const row of matrix.rows) {
    const cells = [
      mdEscape(row.vendor),
      row.enums.interrupt,
      row.enums.mcp,
      permissionModesCell(row.permissionModes),
      row.enums.patchVisibility,
      row.enums.usageReporting,
      row.enums.costReporting,
      row.enums.sandboxing,
      row.enums.streaming,
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }

  return lines.join("\n");
}
