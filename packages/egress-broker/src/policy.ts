/**
 * Policy loading + host matching.
 *
 * The policy is the security-critical input to the broker; treat it as
 * untrusted JSON even when it comes from the shamu daemon. Validation
 * rejects:
 *
 *  - `defaultPolicy` other than `"deny"` (future-proofing for containerized
 *    enforcement that may expand this enum)
 *  - host entries that aren't lowercase DNS-style names
 *  - suffix entries that don't start with `.` (would otherwise create
 *    surprising matches like `.com` allowing everything)
 *  - empty strings, duplicate entries, obviously malformed input
 *
 * The matcher is used by the broker on every `CONNECT` + `HTTP` request, so
 * it runs on a hot path — but the sets are small (<100 entries per run),
 * making a linear scan fine. We normalize once at load time.
 */

import { readFileSync } from "node:fs";
import { type EgressPolicy, EgressPolicyViolation } from "./types.ts";

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Match a single DNS-like hostname. Fully-qualified names (trailing dot),
 * IDN punycode (`xn--...`), and IPv4 dotted quads are all allowed. The
 * broker intentionally rejects IPv6 in literal-bracket form at this layer —
 * a Phase 8 threat-model pass will reintroduce it with explicit handling.
 */
function isValidHostname(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false;
  if (h.startsWith(".") || h.endsWith(".")) return false;
  const labels = h.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!DNS_LABEL.test(label)) return false;
  }
  return true;
}

/**
 * Suffix entries are "dot + hostname". We reject anything else so an
 * operator typo like `fireworks.ai` (meant as suffix) doesn't silently
 * become an exact-match entry.
 */
function isValidSuffix(s: string): boolean {
  if (!s.startsWith(".")) return false;
  const rest = s.slice(1);
  return isValidHostname(rest);
}

/**
 * Parse + validate a raw policy object. Returns a frozen, normalized copy;
 * the input is untouched. Throws `EgressPolicyViolation` on any shape error.
 */
export function loadEgressPolicy(raw: unknown): EgressPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EgressPolicyViolation("policy must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.defaultPolicy !== "deny") {
    throw new EgressPolicyViolation(
      `defaultPolicy must be "deny"; got ${JSON.stringify(obj.defaultPolicy)}`,
    );
  }

  const rawHosts = obj.allowedHosts ?? [];
  if (!Array.isArray(rawHosts)) {
    throw new EgressPolicyViolation("allowedHosts must be an array of strings");
  }
  const hosts: string[] = [];
  const seenHosts = new Set<string>();
  for (const h of rawHosts) {
    if (typeof h !== "string") {
      throw new EgressPolicyViolation(`allowedHosts entries must be strings; got ${typeof h}`);
    }
    const normalized = h.toLowerCase();
    if (!isValidHostname(normalized)) {
      throw new EgressPolicyViolation(
        `allowedHosts entry is not a valid hostname: ${JSON.stringify(h)}`,
      );
    }
    if (seenHosts.has(normalized)) continue;
    seenHosts.add(normalized);
    hosts.push(normalized);
  }

  const rawSuffixes = obj.allowedHostSuffixes ?? [];
  if (!Array.isArray(rawSuffixes)) {
    throw new EgressPolicyViolation("allowedHostSuffixes must be an array of strings");
  }
  const suffixes: string[] = [];
  const seenSuffixes = new Set<string>();
  for (const s of rawSuffixes) {
    if (typeof s !== "string") {
      throw new EgressPolicyViolation(
        `allowedHostSuffixes entries must be strings; got ${typeof s}`,
      );
    }
    const normalized = s.toLowerCase();
    if (!isValidSuffix(normalized)) {
      throw new EgressPolicyViolation(
        `allowedHostSuffixes entry must start with '.' and be a valid hostname: ${JSON.stringify(s)}`,
      );
    }
    if (seenSuffixes.has(normalized)) continue;
    seenSuffixes.add(normalized);
    suffixes.push(normalized);
  }

  let egressLogPath: string | undefined;
  if (obj.egressLogPath !== undefined && obj.egressLogPath !== null) {
    if (typeof obj.egressLogPath !== "string" || obj.egressLogPath.length === 0) {
      throw new EgressPolicyViolation("egressLogPath must be a non-empty string when set");
    }
    egressLogPath = obj.egressLogPath;
  }

  return Object.freeze({
    defaultPolicy: "deny" as const,
    allowedHosts: Object.freeze(hosts.slice()),
    allowedHostSuffixes: Object.freeze(suffixes.slice()),
    ...(egressLogPath !== undefined ? { egressLogPath } : {}),
  });
}

/** Convenience — load a JSON file from disk and validate. */
export function loadEgressPolicyFromFile(path: string): EgressPolicy {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new EgressPolicyViolation(
      `failed to read policy file at ${path}: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new EgressPolicyViolation(
      `policy file ${path} is not valid JSON: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }
  return loadEgressPolicy(parsed);
}

/**
 * Normalize an inbound host for comparison: lowercase, strip trailing dot,
 * drop any IPv6 brackets. Returns `""` for obviously malformed input — the
 * caller treats empty string as "deny" (can't match anything in allow-list).
 */
export function normalizeHost(host: string): string {
  if (typeof host !== "string" || host.length === 0) return "";
  let out = host.trim().toLowerCase();
  if (out.startsWith("[") && out.endsWith("]")) {
    out = out.slice(1, -1);
  }
  if (out.endsWith(".")) out = out.slice(0, -1);
  return out;
}

/**
 * Decide whether `host` is allowed under `policy`. Host matching is
 * case-insensitive; the caller is expected to have already extracted the
 * hostname from `host:port` (the broker does this via `URL` / the CONNECT
 * request line).
 */
export function matchHost(policy: EgressPolicy, host: string): boolean {
  const target = normalizeHost(host);
  if (target.length === 0) return false;
  for (const allowed of policy.allowedHosts) {
    if (allowed === target) return true;
  }
  for (const suffix of policy.allowedHostSuffixes) {
    // Suffix already starts with `.`; require target to end with it so
    // `.fireworks.ai` matches `api.fireworks.ai` but NOT `evilfireworks.ai`.
    // Also allow the suffix itself sans leading dot to match the zone apex,
    // e.g. `.fireworks.ai` matches `fireworks.ai`.
    if (target.endsWith(suffix)) return true;
    if (target === suffix.slice(1)) return true;
  }
  return false;
}

/**
 * Build an in-memory policy from a vendor id's default allow-list. Used by
 * callers that don't have a persisted policy file — the CLI + tests both
 * take this path.
 */
export function policyFromAllowlist(
  allowedHosts: readonly string[],
  allowedHostSuffixes: readonly string[] = [],
): EgressPolicy {
  return loadEgressPolicy({
    defaultPolicy: "deny",
    allowedHosts,
    allowedHostSuffixes,
  });
}
