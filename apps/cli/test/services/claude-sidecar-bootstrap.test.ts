/**
 * Unit tests for `resolveClaudeCliPath` — the four-source precedence chain
 * the `shamu run --adapter=claude` bootstrap uses to decide which binary
 * to pass as `vendorCliPath`.
 *
 * Precedence under test:
 *   explicit > env > sidecar > path
 *
 * All tests inject `ensureSidecar` explicitly so no vendor SDK work runs.
 */

import { describe, expect, it, vi } from "vitest";
import { resolveClaudeCliPath } from "../../src/services/claude-sidecar-bootstrap.ts";

describe("resolveClaudeCliPath", () => {
  it("returns source=explicit when `explicit` is provided, ignoring env and sidecar", async () => {
    const ensureSidecar = vi.fn();
    const res = await resolveClaudeCliPath({
      explicit: "/opt/claude",
      env: { CLAUDE_CLI_PATH: "/ignored/path" },
      ensureSidecar: async (opts) => {
        ensureSidecar(opts);
        return { path: "/also/ignored", version: "x" };
      },
    });
    expect(res).toEqual({ source: "explicit", path: "/opt/claude" });
    expect(ensureSidecar).not.toHaveBeenCalled();
  });

  it("returns source=env when CLAUDE_CLI_PATH is set and no explicit is provided", async () => {
    const ensureSidecar = vi.fn();
    const res = await resolveClaudeCliPath({
      env: { CLAUDE_CLI_PATH: "/env/claude" },
      ensureSidecar: async (opts) => {
        ensureSidecar(opts);
        return { path: "/also/ignored", version: "x" };
      },
    });
    expect(res).toEqual({ source: "env", path: "/env/claude" });
    expect(ensureSidecar).not.toHaveBeenCalled();
  });

  it("returns source=sidecar when explicit and env are absent", async () => {
    const res = await resolveClaudeCliPath({
      env: {},
      ensureSidecar: async () => ({ path: "/cache/claude", version: "1.2.3" }),
    });
    expect(res).toEqual({
      source: "sidecar",
      path: "/cache/claude",
      version: "1.2.3",
    });
  });

  it("falls through to PATH when sidecar bootstrap throws and fallthroughOnSidecarError is default", async () => {
    const onSidecarError = vi.fn();
    const res = await resolveClaudeCliPath({
      env: {},
      ensureSidecar: async () => {
        throw new Error("boom");
      },
      onSidecarError,
    });
    expect(res).toEqual({ source: "path", path: null });
    expect(onSidecarError).toHaveBeenCalledOnce();
    const args = onSidecarError.mock.calls[0] ?? [];
    const firstArg = args[0];
    expect(firstArg).toBeInstanceOf(Error);
    expect((firstArg as Error).message).toBe("boom");
  });

  it("re-throws the sidecar error when fallthroughOnSidecarError=false", async () => {
    await expect(
      resolveClaudeCliPath({
        env: {},
        ensureSidecar: async () => {
          throw new Error("network down");
        },
        fallthroughOnSidecarError: false,
      }),
    ).rejects.toThrow(/network down/);
  });

  it("returns source=path with null path when no ensureSidecar is provided and nothing earlier matches", async () => {
    const res = await resolveClaudeCliPath({ env: {} });
    expect(res).toEqual({ source: "path", path: null });
  });

  it("treats an empty-string explicit as absent", async () => {
    const res = await resolveClaudeCliPath({
      explicit: "",
      env: { CLAUDE_CLI_PATH: "/env/claude" },
    });
    expect(res).toEqual({ source: "env", path: "/env/claude" });
  });

  it("treats an empty-string CLAUDE_CLI_PATH as absent", async () => {
    const res = await resolveClaudeCliPath({
      env: { CLAUDE_CLI_PATH: "" },
      ensureSidecar: async () => ({ path: "/cache/claude", version: "1" }),
    });
    expect(res).toEqual({
      source: "sidecar",
      path: "/cache/claude",
      version: "1",
    });
  });
});
