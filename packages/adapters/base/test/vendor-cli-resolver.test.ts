/**
 * Unit tests for the shared vendor-CLI resolver.
 *
 * These exercise the resolver directly against synthetic descriptors —
 * the per-adapter contract suite under `contract-tests/` proves the same
 * rules against the REAL descriptor each adapter exports.
 */

import { describe, expect, it, vi } from "vitest";
import {
  envVarFor,
  matchesVersionConstraint,
  resolveVendorCli,
  VENDOR_NAMES,
  type VendorCliDescriptor,
  VendorCliNotFoundError,
  VendorCliVersionMismatchError,
} from "../src/vendor-cli-resolver.ts";

const SYNTH_DESCRIPTOR: VendorCliDescriptor = {
  adapter: "gemini",
  binaryNames: ["gemini"],
  candidates: [
    { kind: "absolute", path: "/opt/homebrew/bin/gemini" },
    { kind: "homeRelative", segments: [".bun", "install", "global", "bin", "gemini"] },
    { kind: "pathLookup" },
  ],
  installHint: "install via `npm i -g @google/gemini-cli`",
};

describe("envVarFor", () => {
  it("uppercases and suffixes with _CLI_PATH", () => {
    expect(envVarFor("gemini")).toBe("GEMINI_CLI_PATH");
    expect(envVarFor("codex")).toBe("CODEX_CLI_PATH");
    expect(envVarFor("pi")).toBe("PI_CLI_PATH");
  });
});

describe("VENDOR_NAMES", () => {
  it("covers every shipped adapter (echo + the seven real ones)", () => {
    // Tripwire: if someone adds an adapter without updating the tuple,
    // this breaks loud. The exact set is the contract.
    expect([...VENDOR_NAMES].sort()).toEqual(
      ["echo", "claude", "codex", "cursor", "gemini", "amp", "opencode", "pi"].sort(),
    );
  });
});

describe("resolveVendorCli — no-binary descriptor (echo)", () => {
  it("returns an 'unused' source without touching the filesystem", async () => {
    const existsImpl = vi.fn();
    const whichImpl = vi.fn();
    const result = await resolveVendorCli({
      adapter: "echo",
      descriptor: { adapter: "echo", binaryNames: [], candidates: [] },
      existsImpl,
      whichImpl,
    });
    expect(result.source).toBe("unused");
    expect(result.path).toBe("");
    expect(existsImpl).not.toHaveBeenCalled();
    expect(whichImpl).not.toHaveBeenCalled();
  });
});

describe("resolveVendorCli — precedence", () => {
  it("explicit wins over env, config, candidates, pathLookup", async () => {
    const result = await resolveVendorCli({
      adapter: "gemini",
      descriptor: SYNTH_DESCRIPTOR,
      explicit: "/explicit/gemini",
      env: { GEMINI_CLI_PATH: "/env/gemini" },
      configEntry: { cliPath: "/config/gemini" },
      existsImpl: () => true,
      whichImpl: () => "/path/gemini",
    });
    expect(result).toMatchObject({ source: "explicit", path: "/explicit/gemini" });
  });

  it("explicit that points to a missing file throws VendorCliNotFoundError (never falls through)", async () => {
    await expect(
      resolveVendorCli({
        adapter: "gemini",
        descriptor: SYNTH_DESCRIPTOR,
        explicit: "/missing/gemini",
        env: { GEMINI_CLI_PATH: "/env/gemini" },
        existsImpl: (p) => p === "/env/gemini",
        whichImpl: () => null,
      }),
    ).rejects.toBeInstanceOf(VendorCliNotFoundError);
  });

  it("env wins over config, candidates, pathLookup", async () => {
    const result = await resolveVendorCli({
      adapter: "gemini",
      descriptor: SYNTH_DESCRIPTOR,
      env: { GEMINI_CLI_PATH: "/env/gemini" },
      configEntry: { cliPath: "/config/gemini" },
      existsImpl: () => true,
      whichImpl: () => "/path/gemini",
    });
    expect(result).toMatchObject({ source: "env", path: "/env/gemini" });
  });

  it("config wins over candidates + pathLookup", async () => {
    const result = await resolveVendorCli({
      adapter: "gemini",
      descriptor: SYNTH_DESCRIPTOR,
      env: {},
      configEntry: { cliPath: "/config/gemini" },
      existsImpl: () => true,
      whichImpl: () => "/path/gemini",
    });
    expect(result).toMatchObject({ source: "config", path: "/config/gemini" });
  });

  it("first descriptor candidate wins over pathLookup when it exists", async () => {
    const result = await resolveVendorCli({
      adapter: "gemini",
      descriptor: SYNTH_DESCRIPTOR,
      env: {},
      existsImpl: (p) => p === "/opt/homebrew/bin/gemini",
      whichImpl: () => "/path/gemini",
    });
    expect(result.source).toBe("candidate");
    expect(result.path).toBe("/opt/homebrew/bin/gemini");
  });

  it("later descriptor candidates are checked in order", async () => {
    // First candidate missing, second (homeRelative) exists.
    const result = await resolveVendorCli({
      adapter: "gemini",
      descriptor: SYNTH_DESCRIPTOR,
      env: {},
      existsImpl: (p) => p.endsWith(".bun/install/global/bin/gemini"),
      whichImpl: () => null,
    });
    expect(result.source).toBe("candidate");
  });

  it("pathLookup is last resort", async () => {
    const result = await resolveVendorCli({
      adapter: "gemini",
      descriptor: SYNTH_DESCRIPTOR,
      env: {},
      existsImpl: (p) => p === "/found/via/path",
      whichImpl: () => "/found/via/path",
    });
    expect(result.source).toBe("pathLookup");
    expect(result.path).toBe("/found/via/path");
  });

  it("lastChance fires only after every candidate misses and yields source=lastChance", async () => {
    const lastChance = vi.fn(async () => "/sidecar/gemini");
    const result = await resolveVendorCli({
      adapter: "gemini",
      descriptor: SYNTH_DESCRIPTOR,
      env: {},
      existsImpl: (p) => p === "/sidecar/gemini",
      whichImpl: () => null,
      lastChance,
    });
    expect(lastChance).toHaveBeenCalledOnce();
    expect(result.source).toBe("lastChance");
  });

  it("invokes onLastChanceError when lastChance throws, then raises VendorCliNotFoundError", async () => {
    const onLastChanceError = vi.fn();
    await expect(
      resolveVendorCli({
        adapter: "gemini",
        descriptor: SYNTH_DESCRIPTOR,
        env: {},
        existsImpl: () => false,
        whichImpl: () => null,
        lastChance: async () => {
          throw new Error("sidecar boom");
        },
        onLastChanceError,
      }),
    ).rejects.toBeInstanceOf(VendorCliNotFoundError);
    expect(onLastChanceError).toHaveBeenCalledOnce();
  });
});

describe("resolveVendorCli — structured missing error", () => {
  it("attempts array captures every source in order", async () => {
    try {
      await resolveVendorCli({
        adapter: "gemini",
        descriptor: SYNTH_DESCRIPTOR,
        env: {}, // no env var set
        existsImpl: () => false,
        whichImpl: () => null,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VendorCliNotFoundError);
      const nfe = err as VendorCliNotFoundError;
      const kinds = nfe.attempts.map((a) => a.kind);
      expect(kinds[0]).toBe("explicit");
      expect(kinds[1]).toBe("env");
      expect(kinds[2]).toBe("config");
      // remaining kinds reflect the descriptor candidate list order.
      expect(kinds.slice(3)).toEqual(["absolute", "homeRelative", "pathLookup"]);
    }
  });

  it("error message names the adapter and lists install hint when present", async () => {
    try {
      await resolveVendorCli({
        adapter: "gemini",
        descriptor: SYNTH_DESCRIPTOR,
        env: {},
        existsImpl: () => false,
        whichImpl: () => null,
      });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("gemini");
      expect(msg).toContain(SYNTH_DESCRIPTOR.installHint ?? "");
    }
  });
});

describe("resolveVendorCli — version probe", () => {
  const DESCRIPTOR_WITH_PROBE: VendorCliDescriptor = {
    ...SYNTH_DESCRIPTOR,
    versionProbe: {
      args: ["--version"],
      parse: (stdout) => stdout.trim(),
      constraint: ">=1.0.0 <2.0.0",
    },
  };

  it("runs the probe and returns the parsed version when the constraint is satisfied", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "1.4.2\n", stderr: "" }));
    const result = await resolveVendorCli({
      adapter: "gemini",
      descriptor: DESCRIPTOR_WITH_PROBE,
      explicit: "/some/gemini",
      existsImpl: () => true,
      whichImpl: () => null,
      versionProbeRunner: runner,
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(result.version).toBe("1.4.2");
  });

  it("throws VendorCliVersionMismatchError BEFORE spawning the subprocess when constraint fails", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "0.9.0\n", stderr: "" }));
    await expect(
      resolveVendorCli({
        adapter: "gemini",
        descriptor: DESCRIPTOR_WITH_PROBE,
        explicit: "/some/gemini",
        existsImpl: () => true,
        whichImpl: () => null,
        versionProbeRunner: runner,
      }),
    ).rejects.toBeInstanceOf(VendorCliVersionMismatchError);
  });

  it("configEntry.cliVersionConstraint wins over descriptor constraint", async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "1.4.2\n", stderr: "" }));
    // Descriptor wants >=1.0.0 <2.0.0; config forces >=2.0.0 → should fail.
    await expect(
      resolveVendorCli({
        adapter: "gemini",
        descriptor: DESCRIPTOR_WITH_PROBE,
        explicit: "/some/gemini",
        existsImpl: () => true,
        whichImpl: () => null,
        configEntry: { cliVersionConstraint: ">=2.0.0" },
        versionProbeRunner: runner,
      }),
    ).rejects.toBeInstanceOf(VendorCliVersionMismatchError);
  });

  it("swallows probe-runner errors rather than failing resolution", async () => {
    const runner = vi.fn(async () => {
      throw new Error("probe timeout");
    });
    const result = await resolveVendorCli({
      adapter: "gemini",
      descriptor: DESCRIPTOR_WITH_PROBE,
      explicit: "/some/gemini",
      existsImpl: () => true,
      whichImpl: () => null,
      versionProbeRunner: runner,
    });
    expect(result.path).toBe("/some/gemini");
    expect(result.version).toBeUndefined();
  });
});

describe("matchesVersionConstraint", () => {
  it("accepts exact, >=, <=, >, <, =, ^, ~", () => {
    expect(matchesVersionConstraint("1.2.3", "1.2.3")).toBe(true);
    expect(matchesVersionConstraint("1.2.4", "1.2.3")).toBe(false);
    expect(matchesVersionConstraint("1.2.3", ">=1.2.0")).toBe(true);
    expect(matchesVersionConstraint("1.2.3", "<=1.2.3")).toBe(true);
    expect(matchesVersionConstraint("1.2.3", ">1.2.2")).toBe(true);
    expect(matchesVersionConstraint("1.2.3", "<1.3.0")).toBe(true);
    expect(matchesVersionConstraint("1.2.3", "=1.2.3")).toBe(true);
    expect(matchesVersionConstraint("1.4.0", "^1.2.3")).toBe(true);
    expect(matchesVersionConstraint("2.0.0", "^1.2.3")).toBe(false);
    expect(matchesVersionConstraint("1.2.5", "~1.2.3")).toBe(true);
    expect(matchesVersionConstraint("1.3.0", "~1.2.3")).toBe(false);
  });

  it("honors compound ranges separated by whitespace", () => {
    expect(matchesVersionConstraint("1.4.2", ">=1.0.0 <2.0.0")).toBe(true);
    expect(matchesVersionConstraint("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
  });

  it("returns false for unparseable input rather than throwing", () => {
    expect(matchesVersionConstraint(null, ">=1.0.0")).toBe(false);
    expect(matchesVersionConstraint("not-a-version", ">=1.0.0")).toBe(false);
  });

  it("treats 0.x ^ ranges conservatively (caret-zero rules)", () => {
    expect(matchesVersionConstraint("0.3.1", "^0.3.0")).toBe(true);
    expect(matchesVersionConstraint("0.4.0", "^0.3.0")).toBe(false);
    expect(matchesVersionConstraint("0.0.2", "^0.0.1")).toBe(false);
    expect(matchesVersionConstraint("0.0.1", "^0.0.1")).toBe(true);
  });
});
