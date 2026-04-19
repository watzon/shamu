import { runVendorCliResolverContract } from "@shamu/adapters-base/contract-tests";
import { describe, expect, it } from "vitest";
import { piVendorCliDescriptor } from "../src/vendor-cli-descriptor.ts";

describe("pi vendor-cli descriptor", () => {
  it("declares the canonical binary name", () => {
    expect(piVendorCliDescriptor.adapter).toBe("pi");
    expect(piVendorCliDescriptor.binaryNames).toContain("pi");
  });

  runVendorCliResolverContract({ descriptor: piVendorCliDescriptor });
});
