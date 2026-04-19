/**
 * Unit tests for the Amp driver layer. These deliberately DO NOT spawn a
 * real subprocess — we exercise the pure bits (binary path resolution,
 * argv building, auth resolution).
 *
 * Live-subprocess coverage lives in `test/live/spawn.live.test.ts` gated by
 * `SHAMU_AMP_LIVE=1`.
 */

import { describe, expect, it } from "vitest";
import { AmpAuthError, applyAmpAuth } from "../src/auth.ts";
import { buildAmpArgv, resolveAmpBinaryPath } from "../src/driver.ts";

describe("buildAmpArgv", () => {
  it("spawn shape: [binary, -x, --stream-json, --stream-json-input]", () => {
    const argv = buildAmpArgv("/bin/amp", {});
    expect(argv).toEqual(["/bin/amp", "-x", "--stream-json", "--stream-json-input"]);
  });

  it("resume shape: [binary, threads, continue, <id>, -x, ...]", () => {
    const argv = buildAmpArgv("/bin/amp", { resumeThreadId: "thread-42" });
    expect(argv).toEqual([
      "/bin/amp",
      "threads",
      "continue",
      "thread-42",
      "-x",
      "--stream-json",
      "--stream-json-input",
    ]);
  });

  it("appends extraArgs at the end", () => {
    const argv = buildAmpArgv("/bin/amp", { extraArgs: ["--debug"] });
    expect(argv).toEqual(["/bin/amp", "-x", "--stream-json", "--stream-json-input", "--debug"]);
  });

  it("ignores empty resumeThreadId", () => {
    const argv = buildAmpArgv("/bin/amp", { resumeThreadId: "" });
    expect(argv).toEqual(["/bin/amp", "-x", "--stream-json", "--stream-json-input"]);
  });
});

describe("resolveAmpBinaryPath", () => {
  it("prefers explicit vendorCliPath when it exists", () => {
    const resolved = resolveAmpBinaryPath({
      vendorCliPath: "/opt/amp",
      existsImpl: (p) => p === "/opt/amp",
      whichImpl: () => null,
    });
    expect(resolved).toBe("/opt/amp");
  });

  it("throws when vendorCliPath does not exist", () => {
    expect(() =>
      resolveAmpBinaryPath({
        vendorCliPath: "/opt/missing",
        existsImpl: () => false,
        whichImpl: () => null,
      }),
    ).toThrow(/Amp CLI binary not found at vendorCliPath/);
  });

  it("falls back to AMP_CLI_PATH env when present", () => {
    const resolved = resolveAmpBinaryPath({
      env: { AMP_CLI_PATH: "/env/amp" },
      existsImpl: (p) => p === "/env/amp",
      whichImpl: () => null,
    });
    expect(resolved).toBe("/env/amp");
  });

  it("throws when AMP_CLI_PATH env points at a missing file", () => {
    expect(() =>
      resolveAmpBinaryPath({
        env: { AMP_CLI_PATH: "/env/missing" },
        existsImpl: () => false,
        whichImpl: () => null,
      }),
    ).toThrow(/Amp CLI binary not found at AMP_CLI_PATH/);
  });

  it("falls back to whichImpl when no override is set", () => {
    const resolved = resolveAmpBinaryPath({
      existsImpl: (p) => p === "/usr/local/bin/amp",
      whichImpl: (bin) => (bin === "amp" ? "/usr/local/bin/amp" : null),
    });
    expect(resolved).toBe("/usr/local/bin/amp");
  });

  it("throws with install instructions when no source resolves", () => {
    expect(() =>
      resolveAmpBinaryPath({
        existsImpl: () => false,
        whichImpl: () => null,
      }),
    ).toThrow(/install with `npm install -g @sourcegraph\/amp`/);
  });
});

describe("applyAmpAuth", () => {
  it("returns explicit vendorOpts.apiKey when set", () => {
    const resolved = applyAmpAuth({ apiKey: "amp_live_abc" });
    expect(resolved.apiKey).toBe("amp_live_abc");
    expect(resolved.source).toBe("vendorOpts.apiKey");
  });

  it("falls back to AMP_API_KEY env when vendorOpts omits apiKey", () => {
    const prev = process.env.AMP_API_KEY;
    process.env.AMP_API_KEY = "amp_env_key";
    try {
      const resolved = applyAmpAuth();
      expect(resolved.apiKey).toBe("amp_env_key");
      expect(resolved.source).toBe("env:AMP_API_KEY");
    } finally {
      if (prev === undefined) delete process.env.AMP_API_KEY;
      else process.env.AMP_API_KEY = prev;
    }
  });

  it("returns null apiKey when no source is set", () => {
    const prev = process.env.AMP_API_KEY;
    delete process.env.AMP_API_KEY;
    try {
      const resolved = applyAmpAuth();
      expect(resolved.apiKey).toBeNull();
      expect(resolved.source).toBe("keychain");
    } finally {
      if (prev !== undefined) process.env.AMP_API_KEY = prev;
    }
  });

  it("rejects empty apiKey string", () => {
    expect(() => applyAmpAuth({ apiKey: "" })).toThrow(AmpAuthError);
  });

  it("rejects non-string apiKey", () => {
    // @ts-expect-error — testing runtime validation
    expect(() => applyAmpAuth({ apiKey: 42 })).toThrow(AmpAuthError);
  });
});
