import { describe, expect, it } from "vitest";
import { freezeCapabilities } from "../src/capabilities.ts";
import {
  type AdapterCapabilityEntry,
  buildCapabilityMatrix,
  CAPABILITY_FEATURE_COLUMNS,
  PERMISSION_MODE_ORDER,
  renderCapabilityMatrixMarkdown,
} from "../src/capability-matrix.ts";

/**
 * Two synthetic adapters that exercise every axis of the matrix. Not
 * wired to real adapter JSON files — that's the generator script's job.
 * Unit tests assert the pure data transformation.
 */
const nativeCaps = freezeCapabilities({
  resume: true,
  fork: true,
  interrupt: "cooperative",
  permissionModes: ["default", "acceptEdits", "plan", "bypassPermissions"],
  mcp: "in-process",
  customTools: true,
  patchVisibility: "events",
  usageReporting: "per-turn",
  costReporting: "native",
  sandboxing: "process",
  streaming: "events",
});

const minimalCaps = freezeCapabilities({
  resume: false,
  fork: false,
  interrupt: "none",
  permissionModes: ["default"],
  mcp: "none",
  customTools: false,
  patchVisibility: "filesystem-only",
  usageReporting: "none",
  costReporting: "unknown",
  sandboxing: "none",
  streaming: "final-only",
});

const entries: readonly AdapterCapabilityEntry[] = [
  { vendor: "native-adapter", capabilities: nativeCaps },
  { vendor: "minimal-adapter", capabilities: minimalCaps },
];

describe("buildCapabilityMatrix", () => {
  it("returns one row per adapter in input order", () => {
    const matrix = buildCapabilityMatrix(entries);
    expect(matrix.rows.map((r) => r.vendor)).toEqual(["native-adapter", "minimal-adapter"]);
    expect(matrix.featureColumns).toBe(CAPABILITY_FEATURE_COLUMNS);
  });

  it("resolves every CapabilityFeature column correctly", () => {
    const matrix = buildCapabilityMatrix(entries);
    const native = matrix.rows[0];
    const minimal = matrix.rows[1];
    if (!native || !minimal) throw new Error("expected rows");

    expect(native.features.resume).toBe(true);
    expect(native.features.fork).toBe(true);
    expect(native.features.interrupt).toBe(true);
    expect(native.features.customTools).toBe(true);
    expect(native.features.patchEvents).toBe(true);
    expect(native.features.streamingEvents).toBe(true);
    expect(native.features.usageReporting).toBe(true);
    expect(native.features.costReporting).toBe(true);

    expect(minimal.features.resume).toBe(false);
    expect(minimal.features.fork).toBe(false);
    expect(minimal.features.interrupt).toBe(false);
    expect(minimal.features.customTools).toBe(false);
    expect(minimal.features.patchEvents).toBe(false);
    expect(minimal.features.streamingEvents).toBe(false);
    expect(minimal.features.usageReporting).toBe(false);
    expect(minimal.features.costReporting).toBe(false);
  });

  it("sorts permissionModes by PERMISSION_MODE_ORDER", () => {
    const caps = freezeCapabilities({
      resume: false,
      fork: false,
      interrupt: "none",
      // Intentionally out-of-order input.
      permissionModes: ["bypassPermissions", "acceptEdits", "default"],
      mcp: "none",
      customTools: false,
      patchVisibility: "filesystem-only",
      usageReporting: "none",
      costReporting: "unknown",
      sandboxing: "none",
      streaming: "final-only",
    });
    const matrix = buildCapabilityMatrix([{ vendor: "x", capabilities: caps }]);
    const first = matrix.rows[0];
    if (!first) throw new Error("expected row");
    expect(first.permissionModes).toEqual(["default", "acceptEdits", "bypassPermissions"]);
    // Sanity: PERMISSION_MODE_ORDER is exhaustive / stable.
    expect(PERMISSION_MODE_ORDER).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
  });

  it("carries enum fields through without re-encoding", () => {
    const matrix = buildCapabilityMatrix(entries);
    const native = matrix.rows[0];
    if (!native) throw new Error("expected row");
    expect(native.enums.interrupt).toBe("cooperative");
    expect(native.enums.mcp).toBe("in-process");
    expect(native.enums.patchVisibility).toBe("events");
    expect(native.enums.usageReporting).toBe("per-turn");
    expect(native.enums.costReporting).toBe("native");
    expect(native.enums.sandboxing).toBe("process");
    expect(native.enums.streaming).toBe("events");
  });

  it("is deterministic for identical input", () => {
    const a = buildCapabilityMatrix(entries);
    const b = buildCapabilityMatrix(entries);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

describe("renderCapabilityMatrixMarkdown", () => {
  it("emits two well-formed Markdown tables with header rows", () => {
    const matrix = buildCapabilityMatrix(entries);
    const md = renderCapabilityMatrixMarkdown(matrix);

    expect(md).toContain("### Feature parity");
    expect(md).toContain("### Enum / detail fields");
    // Every feature column shows up in the feature-parity header.
    for (const col of CAPABILITY_FEATURE_COLUMNS) {
      expect(md).toContain(col);
    }
    // Each vendor has a row in both tables (appears at least twice).
    expect((md.match(/native-adapter/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((md.match(/minimal-adapter/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("renders booleans as yes/no", () => {
    const matrix = buildCapabilityMatrix(entries);
    const md = renderCapabilityMatrixMarkdown(matrix);
    // Feature parity row for native-adapter ends with trailing ` yes |`s.
    const nativeRow = md.split("\n").find((line) => line.includes("native-adapter"));
    expect(nativeRow).toBeDefined();
    expect(nativeRow).toContain("yes");

    const minimalRow = md.split("\n").find((line) => line.includes("minimal-adapter"));
    expect(minimalRow).toBeDefined();
    expect(minimalRow).toContain("no");
  });

  it("escapes pipe characters in vendor names", () => {
    const weird: AdapterCapabilityEntry = {
      vendor: "weird|name",
      capabilities: minimalCaps,
    };
    const matrix = buildCapabilityMatrix([weird]);
    const md = renderCapabilityMatrixMarkdown(matrix);
    expect(md).toContain("weird\\|name");
    expect(md).not.toContain("| weird|name |");
  });

  it("renders permission modes as comma-separated list", () => {
    const matrix = buildCapabilityMatrix(entries);
    const md = renderCapabilityMatrixMarkdown(matrix);
    expect(md).toContain("default, acceptEdits, plan, bypassPermissions");
    // Minimal declares only 'default'.
    expect(md).toMatch(/minimal-adapter[^\n]*default/);
  });
});
