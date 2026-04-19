import { runVendorCliResolverContract } from "@shamu/adapters-base/contract-tests";
import { describe, expect, it } from "vitest";
import { codexVendorCliDescriptor } from "../src/vendor-cli-descriptor.ts";

describe("codex vendor-cli descriptor", () => {
  it("declares the canonical binary name", () => {
    expect(codexVendorCliDescriptor.adapter).toBe("codex");
    expect(codexVendorCliDescriptor.binaryNames).toContain("codex");
  });

  runVendorCliResolverContract({ descriptor: codexVendorCliDescriptor });
});
