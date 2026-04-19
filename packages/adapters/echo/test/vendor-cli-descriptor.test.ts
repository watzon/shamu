/**
 * Echo descriptor contract — echo has no vendor CLI, so the descriptor is
 * a no-binary stub. The only assertion here is that the resolver's
 * short-circuit path fires (source="unused") without touching the
 * filesystem. Runs the shared contract suite is NOT applicable because
 * that suite assumes a real binary chain; a dedicated smoke test covers
 * the no-binary path.
 */

import { resolveVendorCli } from "@shamu/adapters-base";
import { describe, expect, it, vi } from "vitest";
import { echoVendorCliDescriptor } from "../src/vendor-cli-descriptor.ts";

describe("echoVendorCliDescriptor", () => {
  it("declares no binary names and no candidates", () => {
    expect(echoVendorCliDescriptor.adapter).toBe("echo");
    expect(echoVendorCliDescriptor.binaryNames).toEqual([]);
    expect(echoVendorCliDescriptor.candidates).toEqual([]);
  });

  it("resolver returns source=unused without touching the filesystem", async () => {
    const existsImpl = vi.fn();
    const whichImpl = vi.fn();
    const result = await resolveVendorCli({
      adapter: "echo",
      descriptor: echoVendorCliDescriptor,
      existsImpl,
      whichImpl,
    });
    expect(result.source).toBe("unused");
    expect(existsImpl).not.toHaveBeenCalled();
    expect(whichImpl).not.toHaveBeenCalled();
  });
});
