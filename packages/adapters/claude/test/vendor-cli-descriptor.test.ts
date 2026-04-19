/**
 * Claude descriptor contract suite. Runs the shared per-adapter
 * contract from `@shamu/adapters-base/contract-tests` against the
 * Claude descriptor, exercising the precedence chain + version-probe
 * error + structured missing-binary error.
 *
 * The sidecar bootstrap lives OUTSIDE the descriptor — it's wired into
 * the resolver as `lastChance` by the CLI — so this suite does NOT
 * exercise sidecar paths (those live in
 * `test/services/claude-sidecar-bootstrap.test.ts` in `apps/cli`).
 */

import { runVendorCliResolverContract } from "@shamu/adapters-base/contract-tests";
import { describe, expect, it } from "vitest";
import { claudeVendorCliDescriptor } from "../src/vendor-cli-descriptor.ts";

describe("claude vendor-cli descriptor", () => {
  it("declares the canonical binary name", () => {
    expect(claudeVendorCliDescriptor.adapter).toBe("claude");
    expect(claudeVendorCliDescriptor.binaryNames).toContain("claude");
  });

  it("candidate list spans bun/npm globals, homebrew, XDG, and PATH", () => {
    const candidateStrings = claudeVendorCliDescriptor.candidates.map((c) => {
      if (c.kind === "absolute") return c.path;
      if (c.kind === "homeRelative") return c.segments.join("/");
      return "pathLookup";
    });
    expect(candidateStrings.some((s) => s.includes(".bun"))).toBe(true);
    expect(candidateStrings.some((s) => s.includes("homebrew") || s.startsWith("/usr"))).toBe(true);
    expect(candidateStrings.some((s) => s.includes(".local/bin"))).toBe(true);
    expect(candidateStrings.includes("pathLookup")).toBe(true);
  });

  runVendorCliResolverContract({ descriptor: claudeVendorCliDescriptor });
});
