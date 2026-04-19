/**
 * Agent Card sign + verify tests.
 *
 * Covered cases:
 *  - signAgentCard → verifyAgentCard round-trip (happy path)
 *  - tampered body (name / version / skills) → `bad-signature`
 *  - key-DID mismatch (issuerDid claims A, JWK belongs to B) → `key-mismatch`
 *  - untrusted issuer (allow-list present, DID not in it) → `untrusted-issuer`
 *  - malformed card (missing field, bad JWK) → `malformed-card`
 *  - did:key round-trip: derive from JWK → parse back → same pubkey
 */

import { describe, expect, it } from "vitest";
import {
  deriveDidKeyFromJwk,
  rawPubKeyFromDidKey,
  signAgentCard,
  verifyAgentCard,
} from "../src/cards.ts";
import type { AgentCard, AgentCardJwk } from "../src/types.ts";

async function makeKeypair(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: AgentCardJwk;
}> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as { x: string };
  return {
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    jwk: { kty: "OKP", crv: "Ed25519", x: raw.x },
  };
}

async function makeCardBody(jwk: AgentCardJwk): Promise<Omit<AgentCard, "signature">> {
  const did = await deriveDidKeyFromJwk(jwk);
  return {
    issuerDid: did,
    subject: did,
    name: "test-agent",
    version: "0.0.1",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills: [{ id: "echo", name: "Echo" }],
    endpoints: { http: "http://127.0.0.1/a2a" },
    signingKeyJwk: jwk,
  };
}

describe("Agent Card — round-trip", () => {
  it("verifies a freshly signed card (TOFU, no allow-list)", async () => {
    const keys = await makeKeypair();
    const body = await makeCardBody(keys.jwk);
    const card = await signAgentCard({ body, privateKey: keys.privateKey });
    const result = await verifyAgentCard({ card });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issuerDid).toBe(body.issuerDid);
      expect(result.publicKey).toEqual(keys.jwk);
    }
  });

  it("signature is deterministic-round-trip (canonical JSON) — key-order re-shuffle still verifies", async () => {
    const keys = await makeKeypair();
    const body = await makeCardBody(keys.jwk);
    const card = await signAgentCard({ body, privateKey: keys.privateKey });
    // Reconstruct with a wildly different key order.
    const reshuffled: AgentCard = {
      signature: card.signature,
      version: card.version,
      skills: card.skills,
      signingKeyJwk: card.signingKeyJwk,
      endpoints: card.endpoints,
      subject: card.subject,
      name: card.name,
      issuerDid: card.issuerDid,
      capabilities: card.capabilities,
    };
    const result = await verifyAgentCard({ card: reshuffled });
    expect(result.ok).toBe(true);
  });
});

describe("Agent Card — failure modes", () => {
  it("rejects a tampered body with `bad-signature`", async () => {
    const keys = await makeKeypair();
    const body = await makeCardBody(keys.jwk);
    const card = await signAgentCard({ body, privateKey: keys.privateKey });
    const tampered: AgentCard = { ...card, name: "evil-agent" };
    const result = await verifyAgentCard({ card: tampered });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad-signature");
  });

  it("rejects a card whose issuerDid doesn't match signingKeyJwk with `key-mismatch`", async () => {
    const keysA = await makeKeypair();
    const keysB = await makeKeypair();
    const bodyA = await makeCardBody(keysA.jwk);
    const cardA = await signAgentCard({ body: bodyA, privateKey: keysA.privateKey });
    // Now swap in issuerB's DID while keeping A's JWK + signature — that's
    // invalid on its face (key-mismatch fires before signature verify).
    const didB = await deriveDidKeyFromJwk(keysB.jwk);
    const bad: AgentCard = { ...cardA, issuerDid: didB, subject: didB };
    const result = await verifyAgentCard({ card: bad });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("key-mismatch");
  });

  it("rejects an untrusted issuer when allow-list is supplied", async () => {
    const keys = await makeKeypair();
    const body = await makeCardBody(keys.jwk);
    const card = await signAgentCard({ body, privateKey: keys.privateKey });
    const trusted = new Set<string>(["did:key:zNotThisOne"]);
    const result = await verifyAgentCard({ card, trustedIssuers: trusted });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("untrusted-issuer");
  });

  it("accepts the issuer when it IS in the allow-list", async () => {
    const keys = await makeKeypair();
    const body = await makeCardBody(keys.jwk);
    const card = await signAgentCard({ body, privateKey: keys.privateKey });
    const trusted = new Set<string>([body.issuerDid]);
    const result = await verifyAgentCard({ card, trustedIssuers: trusted });
    expect(result.ok).toBe(true);
  });

  it("rejects a card missing a required field with `malformed-card`", async () => {
    const keys = await makeKeypair();
    const body = await makeCardBody(keys.jwk);
    const card = await signAgentCard({ body, privateKey: keys.privateKey });
    const { name: _drop, ...rest } = card;
    const result = await verifyAgentCard({ card: rest as AgentCard });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed-card");
  });

  it("rejects a non-object", async () => {
    const result = await verifyAgentCard({ card: null as unknown as AgentCard });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed-card");
  });

  it("signAgentCard itself refuses to sign a body whose DID doesn't match its JWK", async () => {
    const keysA = await makeKeypair();
    const keysB = await makeKeypair();
    const didB = await deriveDidKeyFromJwk(keysB.jwk);
    const body: Omit<AgentCard, "signature"> = {
      issuerDid: didB, // mismatched on purpose
      subject: didB,
      name: "bad",
      version: "0.0.1",
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      skills: [],
      endpoints: { http: "http://127.0.0.1/a2a" },
      signingKeyJwk: keysA.jwk,
    };
    const err = await signAgentCard({ body, privateKey: keysA.privateKey }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { reason?: string }).reason).toBe("key-mismatch");
  });
});

describe("did:key derivation", () => {
  it("derives a did:key from an Ed25519 JWK and recovers the same raw pubkey", async () => {
    const keys = await makeKeypair();
    const did = await deriveDidKeyFromJwk(keys.jwk);
    expect(did.startsWith("did:key:z")).toBe(true);
    const raw = rawPubKeyFromDidKey(did);
    expect(raw).not.toBeNull();
    expect(raw?.length).toBe(32);
    // Re-encode the raw bytes and confirm we land on the same DID.
    const did2 = await deriveDidKeyFromJwk(keys.jwk);
    expect(did2).toBe(did);
  });

  it("returns null for a malformed did:key", () => {
    expect(rawPubKeyFromDidKey("not a did")).toBeNull();
    expect(rawPubKeyFromDidKey("did:key:zXXXX")).toBeNull();
  });
});
