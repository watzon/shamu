/**
 * Canonical-JSON + base64url smoke tests.
 */

import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalJson,
  stringToUtf8,
} from "../src/canonical.ts";

describe("canonicalJson", () => {
  it("sorts object keys lexicographically", () => {
    expect(canonicalJson({ b: 1, a: 2, c: { y: 1, x: 2 } })).toBe(
      '{"a":2,"b":1,"c":{"x":2,"y":1}}',
    );
  });

  it("omits undefined values (matches JSON.stringify)", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("encodes primitives directly", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson("hi")).toBe('"hi"');
    expect(canonicalJson(42)).toBe("42");
  });

  it("throws on non-finite numbers", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("base64url", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const enc = bytesToBase64Url(bytes);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/); // no padding, url alphabet
    const dec = base64UrlToBytes(enc);
    expect(Array.from(dec)).toEqual(Array.from(bytes));
  });

  it("decodes values without padding", () => {
    const enc = bytesToBase64Url(stringToUtf8("abc"));
    expect(enc).not.toContain("=");
    const dec = base64UrlToBytes(enc);
    expect(new TextDecoder().decode(dec)).toBe("abc");
  });
});
