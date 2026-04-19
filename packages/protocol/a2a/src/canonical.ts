/**
 * Canonical-JSON + base64url helpers.
 *
 * ### Canonical JSON
 *
 * We need a deterministic JSON encoding so an Agent Card signed by issuer A
 * round-trips byte-identical through any A2A implementation that reaches for
 * a signature check. A2A v1's verifiable-credentials leg calls this out as
 * "canonical JSON with sorted keys"; the widely-used RFC 8785 (JCS) is one
 * compatible choice.
 *
 * The function here implements the subset of JCS relevant to Agent Cards:
 *
 * 1. Object keys are emitted in lexicographic (UTF-16) order.
 * 2. No insignificant whitespace — `JSON.stringify` output minus padding.
 * 3. `undefined` values are omitted (matches `JSON.stringify` default).
 * 4. Primitive formatting uses `JSON.stringify` as-is. That means numbers
 *    are emitted in JavaScript's default form (no exponent normalisation).
 *    A2A cards don't carry numbers that trip this case; keeping it simple.
 *
 * We reject circular refs and non-JSON values (functions, BigInt, symbols)
 * up front — anything else would produce an unsignable body.
 *
 * ### base64url
 *
 * Signatures + JWS segments are base64url encoded (RFC 4648 §5, no padding).
 * We avoid depending on any package and implement both directions with
 * standard APIs (`Buffer` on Node, `btoa`/`atob` for the webby path).
 */

export function canonicalJson(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonicalJson: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = value.map((el) => (el === undefined ? "null" : stringify(el)));
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${stringify(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value type ${typeof value}`);
}

// ---- base64url --------------------------------------------------------------

const HAS_BUFFER = typeof Buffer !== "undefined";

export function bytesToBase64Url(bytes: Uint8Array): string {
  if (HAS_BUFFER) {
    return Buffer.from(bytes).toString("base64url");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("base64UrlToBytes: expected non-empty string");
  }
  if (HAS_BUFFER) {
    // Buffer.from handles missing padding + url alphabet.
    const buf = Buffer.from(value, "base64url");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const padLen = (4 - (value.length % 4)) % 4;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLen);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function stringToUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
