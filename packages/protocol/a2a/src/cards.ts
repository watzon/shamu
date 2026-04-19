/**
 * Signed Agent Card — sign + verify + issuer-DID derivation.
 *
 * ### The signing surface
 *
 * `signAgentCard(body, privateKey)` takes everything *except* the signature,
 * canonicalizes it (see `canonical.ts`), signs the canonical bytes with the
 * caller's Ed25519 private key, and returns a full `AgentCard` with the
 * base64url signature appended.
 *
 * ### The verification surface
 *
 * `verifyAgentCard(card, trustedIssuers?)` returns a tagged result rather
 * than throwing so the caller can branch on the failure mode without
 * string-matching messages. The four failure reasons:
 *
 * - `malformed-card` — required fields missing / wrong shape / signingKeyJwk
 *   not an Ed25519 OKP JWK / signature not base64url-decodable.
 * - `bad-signature` — the body was tampered with, or the card was signed by
 *   a different key than the one in `signingKeyJwk`.
 * - `key-mismatch` — the `issuerDid` claimed by the card does NOT match the
 *   DID derived from `signingKeyJwk`. This is the check that stops "key A
 *   signs a card claiming issuer B."
 * - `untrusted-issuer` — the card verifies cryptographically, but its
 *   issuer DID isn't in `trustedIssuers`. Only applies when the caller
 *   passed an allow-list; TOFU ("trust on first use") is the default.
 *
 * ### DID derivation
 *
 * A2A cards use the `did:key` method (W3C CCG spec). For Ed25519 that is:
 *
 *   `did:key:z<multibase-base58btc(<multicodec:0xed01>||<raw-32-byte-pubkey>)>`
 *
 * where the leading `z` is the multibase prefix for base58btc and `0xed01`
 * is the multicodec code for Ed25519-pub. We do the multibase+multicodec
 * byte-wrangling inline because the package takes no external deps.
 */

import { base64UrlToBytes, bytesToBase64Url, canonicalJson, stringToUtf8 } from "./canonical.ts";
import { A2aCardVerificationError, type AgentCardVerificationReason } from "./errors.ts";
import type { AgentCard, AgentCardJwk } from "./types.ts";

export interface SignAgentCardOptions {
  readonly body: Omit<AgentCard, "signature">;
  readonly privateKey: CryptoKey;
}

export async function signAgentCard(opts: SignAgentCardOptions): Promise<AgentCard> {
  // Ensure issuerDid matches the signing key up front — otherwise the card
  // would verify cryptographically and then trip `key-mismatch` on first
  // inbound check. Catching it at sign-time is cheaper + clearer.
  if (opts.privateKey.type !== "private") {
    throw new A2aCardVerificationError(
      "malformed-card",
      "signAgentCard: privateKey must be a private CryptoKey",
    );
  }
  const expected = await deriveDidKeyFromJwk(opts.body.signingKeyJwk);
  if (opts.body.issuerDid !== expected) {
    throw new A2aCardVerificationError(
      "key-mismatch",
      `signAgentCard: issuerDid ${opts.body.issuerDid} does not match derived ${expected}`,
    );
  }
  const canonical = canonicalJson(opts.body);
  const signatureBuf = await crypto.subtle.sign(
    "Ed25519",
    opts.privateKey,
    stringToUtf8(canonical),
  );
  const signature = bytesToBase64Url(new Uint8Array(signatureBuf));
  return { ...opts.body, signature };
}

export interface VerifyAgentCardOptions {
  readonly card: AgentCard;
  /**
   * Optional DID allow-list. When supplied, a card whose `issuerDid` isn't
   * in the set returns `{ ok: false, reason: "untrusted-issuer" }` even
   * though the signature is valid. When omitted, any cryptographically
   * valid card is accepted (TOFU).
   */
  readonly trustedIssuers?: ReadonlySet<string>;
}

export type VerifyAgentCardResult =
  | { readonly ok: true; readonly issuerDid: string; readonly publicKey: AgentCardJwk }
  | { readonly ok: false; readonly reason: AgentCardVerificationReason };

export async function verifyAgentCard(
  opts: VerifyAgentCardOptions,
): Promise<VerifyAgentCardResult> {
  const card = opts.card;
  if (!isLikelyCard(card)) {
    return { ok: false, reason: "malformed-card" };
  }

  // DID-binding check: the card's `issuerDid` must be the one you'd derive
  // from `signingKeyJwk` under did:key. Stops "I signed this card but
  // claimed to be someone else."
  let derivedDid: string;
  try {
    derivedDid = await deriveDidKeyFromJwk(card.signingKeyJwk);
  } catch {
    return { ok: false, reason: "malformed-card" };
  }
  if (derivedDid !== card.issuerDid) {
    return { ok: false, reason: "key-mismatch" };
  }

  // Cryptographic verification.
  let publicKey: CryptoKey;
  try {
    publicKey = await importAgentCardJwk(card.signingKeyJwk);
  } catch {
    return { ok: false, reason: "malformed-card" };
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlToBytes(card.signature);
  } catch {
    return { ok: false, reason: "malformed-card" };
  }

  const { signature: _omit, ...body } = card;
  const canonical = canonicalJson(body);
  const ok = await crypto.subtle.verify(
    "Ed25519",
    publicKey,
    signatureBytes,
    stringToUtf8(canonical),
  );
  if (!ok) return { ok: false, reason: "bad-signature" };

  if (opts.trustedIssuers && !opts.trustedIssuers.has(card.issuerDid)) {
    return { ok: false, reason: "untrusted-issuer" };
  }

  return { ok: true, issuerDid: card.issuerDid, publicKey: card.signingKeyJwk };
}

/**
 * Import an Agent Card's `signingKeyJwk` into a usable Ed25519 public
 * `CryptoKey`. Throws on a malformed JWK.
 */
export async function importAgentCardJwk(jwk: AgentCardJwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk as unknown as JsonWebKeyLike,
    { name: "Ed25519" },
    true,
    ["verify"],
  );
}

/**
 * Structural alias for the WebCrypto `JsonWebKey` type. We don't import it
 * from `node:crypto` (wrong module) and can't reach the DOM lib without
 * pulling the full `lib.dom.d.ts` set; the shape below is the stable subset
 * `importKey("jwk", …)` actually inspects.
 */
interface JsonWebKeyLike {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  [k: string]: unknown;
}

/**
 * Derive the `did:key` DID for an Ed25519 JWK. Multibase-base58btc over
 * `0xed01 || 32 raw pubkey bytes`.
 */
export async function deriveDidKeyFromJwk(jwk: AgentCardJwk): Promise<string> {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new TypeError("deriveDidKeyFromJwk: JWK is not an Ed25519 OKP key");
  }
  const raw = base64UrlToBytes(jwk.x);
  if (raw.length !== 32) {
    throw new TypeError(`deriveDidKeyFromJwk: expected 32-byte Ed25519 pubkey, got ${raw.length}`);
  }
  const multicodec = new Uint8Array(2 + raw.length);
  multicodec[0] = 0xed;
  multicodec[1] = 0x01;
  multicodec.set(raw, 2);
  const base58 = base58btcEncode(multicodec);
  return `did:key:z${base58}`;
}

/**
 * The inverse: given a `did:key:z...` for an Ed25519 key, recover the raw
 * 32-byte pubkey. Returns `null` when the DID isn't a well-formed
 * Ed25519-multicodec did:key.
 */
export function rawPubKeyFromDidKey(did: string): Uint8Array | null {
  if (typeof did !== "string") return null;
  const prefix = "did:key:z";
  if (!did.startsWith(prefix)) return null;
  const body = did.slice(prefix.length);
  let decoded: Uint8Array;
  try {
    decoded = base58btcDecode(body);
  } catch {
    return null;
  }
  if (decoded.length < 3) return null;
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) return null;
  const raw = decoded.slice(2);
  if (raw.length !== 32) return null;
  return raw;
}

/**
 * Build an Ed25519 public-key JWK (just enough to pass back through
 * `importAgentCardJwk` or a trust store) from a raw 32-byte pubkey.
 */
export function rawPubKeyToJwk(raw: Uint8Array): AgentCardJwk {
  if (raw.length !== 32) {
    throw new TypeError(`rawPubKeyToJwk: expected 32 bytes, got ${raw.length}`);
  }
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: bytesToBase64Url(raw),
  };
}

// ---- helpers ---------------------------------------------------------------

function isLikelyCard(value: unknown): value is AgentCard {
  if (value === null || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  if (typeof c.issuerDid !== "string" || c.issuerDid.length === 0) return false;
  if (typeof c.subject !== "string") return false;
  if (typeof c.name !== "string") return false;
  if (typeof c.version !== "string") return false;
  if (typeof c.signature !== "string" || c.signature.length === 0) return false;
  const jwk = c.signingKeyJwk as Record<string, unknown> | undefined;
  if (!jwk || typeof jwk !== "object") return false;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") return false;
  const caps = c.capabilities as Record<string, unknown> | undefined;
  if (!caps || typeof caps !== "object") return false;
  if (
    typeof caps.streaming !== "boolean" ||
    typeof caps.pushNotifications !== "boolean" ||
    typeof caps.stateTransitionHistory !== "boolean"
  ) {
    return false;
  }
  if (!Array.isArray(c.skills)) return false;
  const endpoints = c.endpoints as Record<string, unknown> | undefined;
  if (!endpoints || typeof endpoints !== "object") return false;
  if (typeof endpoints.http !== "string" || endpoints.http.length === 0) return false;
  return true;
}

// ---- base58btc encode / decode ---------------------------------------------
//
// Minimal Bitcoin-alphabet base58 (no Flickr / Ripple). Enough for did:key's
// multibase prefix; not optimized for large inputs — Agent Card keys are
// always 34 bytes (2 multicodec + 32 pubkey).

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP: Readonly<Record<string, number>> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    m[BASE58_ALPHABET[i] as string] = i;
  }
  return Object.freeze(m);
})();

export function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  // Count leading zeros.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Convert base-256 digits to base-58 digits.
  const size = Math.floor(((bytes.length - zeros) * 138) / 100) + 1;
  const b58 = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 256 * (b58[k] as number);
      b58[k] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    length = j;
  }
  let i = size - length;
  while (i < size && b58[i] === 0) i++;
  let out = "";
  for (let k = 0; k < zeros; k++) out += "1";
  for (; i < size; i++) out += BASE58_ALPHABET[b58[i] as number];
  return out;
}

export function base58btcDecode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const size = Math.floor(((str.length - zeros) * 733) / 1000) + 1;
  const bytes = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < str.length; i++) {
    const ch = str[i] as string;
    const digit = BASE58_MAP[ch];
    if (digit === undefined) {
      throw new TypeError(`base58btcDecode: invalid character ${ch}`);
    }
    let carry = digit;
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 58 * (bytes[k] as number);
      bytes[k] = carry & 0xff;
      carry >>= 8;
    }
    length = j;
  }
  let i = size - length;
  while (i < size && bytes[i] === 0) i++;
  const out = new Uint8Array(zeros + (size - i));
  // leading zeros already 0; copy remainder
  for (let k = 0; k < size - i; k++) {
    out[zeros + k] = bytes[i + k] as number;
  }
  return out;
}
