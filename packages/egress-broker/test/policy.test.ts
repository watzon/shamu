/**
 * Policy loader + matcher unit tests.
 *
 * Covers shape validation (default-deny gate, array types, suffix
 * leading-dot rule, hostname RFC shape), normalization (case, trailing
 * dot, IPv6 brackets), and matching semantics (exact, suffix,
 * suffix-vs-apex, non-match, default-deny fallback).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EgressPolicyViolation,
  loadEgressPolicy,
  loadEgressPolicyFromFile,
  matchHost,
  normalizeHost,
  policyFromAllowlist,
} from "../src/index.ts";

describe("loadEgressPolicy — validation", () => {
  it("accepts a minimal valid policy", () => {
    const p = loadEgressPolicy({
      defaultPolicy: "deny",
      allowedHosts: ["api.anthropic.com"],
      allowedHostSuffixes: [".fireworks.ai"],
    });
    expect(p.defaultPolicy).toBe("deny");
    expect(p.allowedHosts).toEqual(["api.anthropic.com"]);
    expect(p.allowedHostSuffixes).toEqual([".fireworks.ai"]);
  });

  it("defaults allowedHosts + allowedHostSuffixes to empty", () => {
    const p = loadEgressPolicy({ defaultPolicy: "deny" });
    expect(p.allowedHosts).toEqual([]);
    expect(p.allowedHostSuffixes).toEqual([]);
  });

  it("rejects non-object input", () => {
    expect(() => loadEgressPolicy(null)).toThrow(EgressPolicyViolation);
    expect(() => loadEgressPolicy("nope")).toThrow(EgressPolicyViolation);
    expect(() => loadEgressPolicy([])).toThrow(EgressPolicyViolation);
  });

  it("rejects defaultPolicy !== 'deny'", () => {
    expect(() => loadEgressPolicy({ defaultPolicy: "allow", allowedHosts: [] })).toThrow(
      EgressPolicyViolation,
    );
    expect(() => loadEgressPolicy({ defaultPolicy: "" })).toThrow(EgressPolicyViolation);
  });

  it("rejects non-array host lists", () => {
    expect(() =>
      loadEgressPolicy({ defaultPolicy: "deny", allowedHosts: "api.anthropic.com" }),
    ).toThrow(EgressPolicyViolation);
    expect(() => loadEgressPolicy({ defaultPolicy: "deny", allowedHostSuffixes: "x" })).toThrow(
      EgressPolicyViolation,
    );
  });

  it("rejects non-string host entries", () => {
    expect(() => loadEgressPolicy({ defaultPolicy: "deny", allowedHosts: [123] })).toThrow(
      EgressPolicyViolation,
    );
  });

  it("rejects invalid hostnames", () => {
    expect(() => loadEgressPolicy({ defaultPolicy: "deny", allowedHosts: [""] })).toThrow(
      EgressPolicyViolation,
    );
    expect(() => loadEgressPolicy({ defaultPolicy: "deny", allowedHosts: ["has spaces"] })).toThrow(
      EgressPolicyViolation,
    );
    expect(() =>
      loadEgressPolicy({ defaultPolicy: "deny", allowedHosts: ["api.anthropic.com."] }),
    ).toThrow(EgressPolicyViolation);
  });

  it("rejects suffix entries that don't start with '.'", () => {
    expect(() =>
      loadEgressPolicy({
        defaultPolicy: "deny",
        allowedHostSuffixes: ["fireworks.ai"],
      }),
    ).toThrow(EgressPolicyViolation);
  });

  it("rejects suffix entries whose body isn't a valid hostname", () => {
    expect(() =>
      loadEgressPolicy({
        defaultPolicy: "deny",
        allowedHostSuffixes: ["."],
      }),
    ).toThrow(EgressPolicyViolation);
    expect(() =>
      loadEgressPolicy({
        defaultPolicy: "deny",
        allowedHostSuffixes: [".not good"],
      }),
    ).toThrow(EgressPolicyViolation);
  });

  it("lowercases and dedupes host entries", () => {
    const p = loadEgressPolicy({
      defaultPolicy: "deny",
      allowedHosts: ["API.Anthropic.COM", "api.anthropic.com", "api.openai.com"],
      allowedHostSuffixes: [".Fireworks.AI", ".fireworks.ai"],
    });
    expect(p.allowedHosts).toEqual(["api.anthropic.com", "api.openai.com"]);
    expect(p.allowedHostSuffixes).toEqual([".fireworks.ai"]);
  });

  it("accepts egressLogPath when non-empty string", () => {
    const p = loadEgressPolicy({
      defaultPolicy: "deny",
      allowedHosts: [],
      egressLogPath: "/tmp/audit.jsonl",
    });
    expect(p.egressLogPath).toBe("/tmp/audit.jsonl");
  });

  it("rejects empty egressLogPath", () => {
    expect(() => loadEgressPolicy({ defaultPolicy: "deny", egressLogPath: "" })).toThrow(
      EgressPolicyViolation,
    );
  });

  it("policy is frozen", () => {
    const p = loadEgressPolicy({ defaultPolicy: "deny", allowedHosts: ["x.com"] });
    expect(Object.isFrozen(p)).toBe(true);
  });
});

describe("loadEgressPolicyFromFile", () => {
  it("reads + parses a JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "shamu-egress-"));
    try {
      const path = join(dir, "policy.json");
      writeFileSync(
        path,
        JSON.stringify({
          defaultPolicy: "deny",
          allowedHosts: ["api.anthropic.com"],
        }),
        "utf8",
      );
      const p = loadEgressPolicyFromFile(path);
      expect(p.allowedHosts).toEqual(["api.anthropic.com"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws EgressPolicyViolation on missing file", () => {
    expect(() => loadEgressPolicyFromFile("/nonexistent/policy.json")).toThrow(
      EgressPolicyViolation,
    );
  });

  it("throws on invalid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "shamu-egress-"));
    try {
      const path = join(dir, "bad.json");
      writeFileSync(path, "{not json", "utf8");
      expect(() => loadEgressPolicyFromFile(path)).toThrow(EgressPolicyViolation);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("normalizeHost", () => {
  it("lowercases", () => {
    expect(normalizeHost("API.ANTHROPIC.COM")).toBe("api.anthropic.com");
  });

  it("strips trailing dot", () => {
    expect(normalizeHost("api.anthropic.com.")).toBe("api.anthropic.com");
  });

  it("strips IPv6 brackets", () => {
    expect(normalizeHost("[::1]")).toBe("::1");
  });

  it("returns '' for empty or non-string", () => {
    expect(normalizeHost("")).toBe("");
  });
});

describe("matchHost — allow semantics", () => {
  const policy = loadEgressPolicy({
    defaultPolicy: "deny",
    allowedHosts: ["api.anthropic.com", "api.openai.com"],
    allowedHostSuffixes: [".fireworks.ai"],
  });

  it("exact-match allow", () => {
    expect(matchHost(policy, "api.anthropic.com")).toBe(true);
    expect(matchHost(policy, "api.openai.com")).toBe(true);
  });

  it("case-insensitive + trailing-dot-tolerant", () => {
    expect(matchHost(policy, "API.Anthropic.COM")).toBe(true);
    expect(matchHost(policy, "api.anthropic.com.")).toBe(true);
  });

  it("suffix allow with dot boundary", () => {
    expect(matchHost(policy, "api.fireworks.ai")).toBe(true);
    expect(matchHost(policy, "inference.fireworks.ai")).toBe(true);
  });

  it("suffix also matches the apex (.fireworks.ai → fireworks.ai)", () => {
    expect(matchHost(policy, "fireworks.ai")).toBe(true);
  });
});

describe("matchHost — deny semantics", () => {
  const policy = loadEgressPolicy({
    defaultPolicy: "deny",
    allowedHosts: ["api.anthropic.com"],
    allowedHostSuffixes: [".fireworks.ai"],
  });

  it("denies unrelated hosts", () => {
    expect(matchHost(policy, "attacker.com")).toBe(false);
    expect(matchHost(policy, "api.openai.com")).toBe(false);
  });

  it("suffix entry does NOT permit naive prefix (evilfireworks.ai)", () => {
    expect(matchHost(policy, "evilfireworks.ai")).toBe(false);
  });

  it("empty host denied", () => {
    expect(matchHost(policy, "")).toBe(false);
  });

  it("default-deny: empty policy rejects everything", () => {
    const empty = loadEgressPolicy({ defaultPolicy: "deny" });
    expect(matchHost(empty, "api.anthropic.com")).toBe(false);
    expect(matchHost(empty, "attacker.com")).toBe(false);
  });
});

describe("policyFromAllowlist", () => {
  it("builds an equivalent policy from explicit lists", () => {
    const p = policyFromAllowlist(["api.anthropic.com"], [".fireworks.ai"]);
    expect(matchHost(p, "api.anthropic.com")).toBe(true);
    expect(matchHost(p, "models.fireworks.ai")).toBe(true);
    expect(matchHost(p, "attacker.com")).toBe(false);
  });
});
