import { runVendorCliResolverContract } from "@shamu/adapters-base/contract-tests";
import { describe, expect, it } from "vitest";
import { geminiVendorCliDescriptor } from "../src/vendor-cli-descriptor.ts";

describe("gemini vendor-cli descriptor", () => {
  it("declares the canonical binary name and includes the @google/gemini-cli npm-global layout", () => {
    expect(geminiVendorCliDescriptor.adapter).toBe("gemini");
    expect(geminiVendorCliDescriptor.binaryNames).toContain("gemini");
    const homeRelSegs = geminiVendorCliDescriptor.candidates
      .filter(
        (c): c is { kind: "homeRelative"; segments: readonly string[] } =>
          c.kind === "homeRelative",
      )
      .map((c) => c.segments.join("/"));
    expect(homeRelSegs.some((s) => s.includes("@google/gemini-cli"))).toBe(true);
  });

  runVendorCliResolverContract({ descriptor: geminiVendorCliDescriptor });
});
