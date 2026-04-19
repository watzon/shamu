/**
 * Unit tests for `buildClaudeLastChance` — the thin wrapper that adapts
 * `ensureClaudeSidecar()` into the `VendorCliResolverInput.lastChance`
 * hook shape expected by `resolveVendorCli`.
 *
 * The old `resolveClaudeCliPath` precedence chain (Phase 8.C.2) collapsed
 * into the shared resolver in Phase 9.A. The only logic this file owns
 * today is "sidecar returns a path" vs "sidecar throws" — precedence is
 * covered by the vendor-CLI resolver suite.
 */

import { describe, expect, it, vi } from "vitest";
import { buildClaudeLastChance } from "../../src/services/claude-sidecar-bootstrap.ts";

describe("buildClaudeLastChance", () => {
  it("returns the sidecar path when ensureSidecar resolves", async () => {
    const lastChance = buildClaudeLastChance({
      ensureSidecar: async () => ({ path: "/cache/claude", version: "1.2.3" }),
    });
    const result = await lastChance();
    expect(result).toBe("/cache/claude");
  });

  it("propagates the sidecar error after invoking onSidecarError", async () => {
    const onSidecarError = vi.fn();
    const lastChance = buildClaudeLastChance({
      ensureSidecar: async () => {
        throw new Error("network down");
      },
      onSidecarError,
    });
    await expect(lastChance()).rejects.toThrow(/network down/);
    expect(onSidecarError).toHaveBeenCalledOnce();
    const firstArg = onSidecarError.mock.calls[0]?.[0];
    expect(firstArg).toBeInstanceOf(Error);
    expect((firstArg as Error).message).toBe("network down");
  });

  it("propagates the sidecar error when no onSidecarError hook is supplied", async () => {
    const lastChance = buildClaudeLastChance({
      ensureSidecar: async () => {
        throw new Error("boom");
      },
    });
    await expect(lastChance()).rejects.toThrow(/boom/);
  });
});
