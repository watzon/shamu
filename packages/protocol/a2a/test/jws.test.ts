/**
 * Compact-JWS (EdDSA) sign/parse/verify smoke tests.
 */

import { describe, expect, it } from "vitest";
import { parseJws, signJws, verifyJwsSignature } from "../src/jws.ts";

async function kp(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
}

describe("signJws / parseJws / verifyJwsSignature", () => {
  it("round-trips a claim set and verifies with the signing key", async () => {
    const keys = await kp();
    const jws = await signJws({
      header: { alg: "EdDSA", typ: "JWT" },
      claims: { iss: "did:key:zAlice", aud: "did:key:zBob", iat: 1, exp: 2 },
      privateKey: keys.privateKey,
    });
    expect(jws.split(".")).toHaveLength(3);
    const parsed = parseJws(jws);
    expect(parsed.claims.iss).toBe("did:key:zAlice");
    const ok = await verifyJwsSignature(parsed, keys.publicKey);
    expect(ok).toBe(true);
  });

  it("fails verification with a different key", async () => {
    const keys = await kp();
    const other = await kp();
    const jws = await signJws({
      header: { alg: "EdDSA" },
      claims: { iss: "did:key:zAlice" },
      privateKey: keys.privateKey,
    });
    const parsed = parseJws(jws);
    const ok = await verifyJwsSignature(parsed, other.publicKey);
    expect(ok).toBe(false);
  });

  it("rejects a malformed compact JWS", () => {
    expect(() => parseJws("not-three-segments")).toThrow();
    expect(() => parseJws("a.b")).toThrow();
  });

  it("rejects a header with an unsupported alg", async () => {
    // manually craft: base64url("{\"alg\":\"HS256\"}") . base64url("{\"iss\":\"x\"}") . "sig"
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: "x" })).toString("base64url");
    const fake = `${header}.${payload}.sig`;
    expect(() => parseJws(fake)).toThrow(/unsupported alg/);
  });

  it("rejects claims missing `iss`", () => {
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({})).toString("base64url");
    const fake = `${header}.${payload}.sig`;
    expect(() => parseJws(fake)).toThrow(/iss/);
  });
});
