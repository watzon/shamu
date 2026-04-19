import { runVendorCliResolverContract } from "@shamu/adapters-base/contract-tests";
import { describe, expect, it } from "vitest";
import { cursorVendorCliDescriptor } from "../src/vendor-cli-descriptor.ts";

describe("cursor vendor-cli descriptor", () => {
  it("declares the canonical binary name and includes Cursor Desktop's symlink", () => {
    expect(cursorVendorCliDescriptor.adapter).toBe("cursor");
    expect(cursorVendorCliDescriptor.binaryNames).toContain("cursor-agent");
    // The Cursor Desktop installer's `~/.local/bin/agent` symlink must be in the
    // candidate list — it's the canonical install location per Phase 7.B's
    // transport-decision doc.
    const homeRelSegs = cursorVendorCliDescriptor.candidates
      .filter(
        (c): c is { kind: "homeRelative"; segments: readonly string[] } =>
          c.kind === "homeRelative",
      )
      .map((c) => c.segments.join("/"));
    expect(homeRelSegs.some((s) => s === ".local/bin/agent")).toBe(true);
  });

  runVendorCliResolverContract({ descriptor: cursorVendorCliDescriptor });
});
