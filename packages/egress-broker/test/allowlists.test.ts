/**
 * Asserts the per-vendor default allow-lists expose the canonical host
 * each adapter is expected to reach. This is a regression guard — if a
 * vendor's adapter picks up a new API surface, the test fails until the
 * allow-list is updated explicitly (no silent permissiveness).
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWLISTS, matchHost, policyFromAllowlist, type VendorId } from "../src/index.ts";

function policyFor(vendor: VendorId) {
  const entry = DEFAULT_ALLOWLISTS[vendor];
  return policyFromAllowlist(entry.allowedHosts, entry.allowedHostSuffixes);
}

describe("DEFAULT_ALLOWLISTS — shape", () => {
  const vendors: readonly VendorId[] = [
    "anthropic",
    "openai",
    "cursor",
    "gemini",
    "amp",
    "pi",
    "opencode",
  ];

  it("has an entry for every declared VendorId", () => {
    for (const v of vendors) {
      expect(DEFAULT_ALLOWLISTS[v]).toBeDefined();
    }
  });

  it("every entry has a non-empty host or suffix list", () => {
    for (const v of vendors) {
      const entry = DEFAULT_ALLOWLISTS[v];
      const total = entry.allowedHosts.length + entry.allowedHostSuffixes.length;
      expect(total, `vendor ${v} should declare at least one host`).toBeGreaterThan(0);
    }
  });
});

describe("DEFAULT_ALLOWLISTS — required hosts per vendor", () => {
  it("anthropic → api.anthropic.com", () => {
    expect(matchHost(policyFor("anthropic"), "api.anthropic.com")).toBe(true);
  });

  it("openai → api.openai.com", () => {
    expect(matchHost(policyFor("openai"), "api.openai.com")).toBe(true);
  });

  it("cursor → cursor.com + api.cursor.com + api2.cursor.sh", () => {
    const p = policyFor("cursor");
    expect(matchHost(p, "cursor.com")).toBe(true);
    expect(matchHost(p, "api.cursor.com")).toBe(true);
    expect(matchHost(p, "api2.cursor.sh")).toBe(true);
  });

  it("gemini → generativelanguage.googleapis.com + oauth endpoints", () => {
    const p = policyFor("gemini");
    expect(matchHost(p, "generativelanguage.googleapis.com")).toBe(true);
    expect(matchHost(p, "oauth2.googleapis.com")).toBe(true);
    expect(matchHost(p, "accounts.google.com")).toBe(true);
  });

  it("amp → ampcode.com + subdomains", () => {
    const p = policyFor("amp");
    expect(matchHost(p, "ampcode.com")).toBe(true);
    expect(matchHost(p, "api.ampcode.com")).toBe(true);
  });

  it("pi → union of Anthropic / OpenAI / Google / Fireworks", () => {
    const p = policyFor("pi");
    expect(matchHost(p, "api.anthropic.com")).toBe(true);
    expect(matchHost(p, "api.openai.com")).toBe(true);
    expect(matchHost(p, "generativelanguage.googleapis.com")).toBe(true);
    expect(matchHost(p, "models.fireworks.ai")).toBe(true);
  });

  it("opencode → Anthropic + OpenAI + Google (BYO-provider baseline)", () => {
    const p = policyFor("opencode");
    expect(matchHost(p, "api.anthropic.com")).toBe(true);
    expect(matchHost(p, "api.openai.com")).toBe(true);
    expect(matchHost(p, "generativelanguage.googleapis.com")).toBe(true);
  });
});

describe("DEFAULT_ALLOWLISTS — negative cases", () => {
  it("anthropic allow-list does NOT leak to openai host", () => {
    expect(matchHost(policyFor("anthropic"), "api.openai.com")).toBe(false);
  });

  it("attacker.com is denied under every default allow-list", () => {
    const vendors: readonly VendorId[] = [
      "anthropic",
      "openai",
      "cursor",
      "gemini",
      "amp",
      "pi",
      "opencode",
    ];
    for (const v of vendors) {
      expect(matchHost(policyFor(v), "attacker.com"), `vendor ${v} must deny attacker.com`).toBe(
        false,
      );
    }
  });
});
