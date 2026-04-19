import { runVendorCliResolverContract } from "@shamu/adapters-base/contract-tests";
import { describe, expect, it } from "vitest";
import { ampVendorCliDescriptor } from "../src/vendor-cli-descriptor.ts";

describe("amp vendor-cli descriptor", () => {
  it("declares the canonical binary name", () => {
    expect(ampVendorCliDescriptor.adapter).toBe("amp");
    expect(ampVendorCliDescriptor.binaryNames).toContain("amp");
  });

  runVendorCliResolverContract({ descriptor: ampVendorCliDescriptor });
});
