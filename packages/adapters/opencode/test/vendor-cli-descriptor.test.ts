import { runVendorCliResolverContract } from "@shamu/adapters-base/contract-tests";
import { describe, expect, it } from "vitest";
import { opencodeVendorCliDescriptor } from "../src/vendor-cli-descriptor.ts";

describe("opencode vendor-cli descriptor", () => {
  it("declares the canonical binary name", () => {
    expect(opencodeVendorCliDescriptor.adapter).toBe("opencode");
    expect(opencodeVendorCliDescriptor.binaryNames).toContain("opencode");
  });

  runVendorCliResolverContract({ descriptor: opencodeVendorCliDescriptor });
});
