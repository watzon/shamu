/**
 * Minimal Ed25519 JWS (compact serialization) helper.
 *
 * A2A v1's bearer-token format is a signed JWT with `alg: "EdDSA"` whose
 * issuer is the Agent Card's `issuerDid`. We don't need the full JWS/JWT
 * surface — just enough to:
 *
 * 1. Produce `<b64url(header)>.<b64url(payload)>.<b64url(signature)>`.
 * 2. Parse the three segments + verify the signature + surface typed claims.
 *
 * Pulling in `jose` / `did-jwt` would bloat the package and force a
 * dep-vendoring exercise. The logic below is 30 lines of `crypto.subtle`.
 */

import { base64UrlToBytes, bytesToBase64Url, stringToUtf8 } from "./canonical.ts";

export interface JwsHeader {
  readonly alg: "EdDSA";
  readonly typ?: string;
  readonly kid?: string;
}

export interface JwtClaims {
  readonly iss: string;
  readonly sub?: string;
  readonly aud?: string;
  /** Epoch seconds. */
  readonly iat?: number;
  /** Epoch seconds. */
  readonly exp?: number;
  readonly [k: string]: unknown;
}

export interface SignJwsOptions {
  readonly header: JwsHeader;
  readonly claims: JwtClaims;
  readonly privateKey: CryptoKey;
}

export async function signJws(opts: SignJwsOptions): Promise<string> {
  if (opts.header.alg !== "EdDSA") {
    throw new TypeError(`signJws: unsupported alg ${String(opts.header.alg)}`);
  }
  const headerJson = JSON.stringify(opts.header);
  const payloadJson = JSON.stringify(opts.claims);
  const headerB64 = bytesToBase64Url(stringToUtf8(headerJson));
  const payloadB64 = bytesToBase64Url(stringToUtf8(payloadJson));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigBuf = await crypto.subtle.sign("Ed25519", opts.privateKey, stringToUtf8(signingInput));
  const sigB64 = bytesToBase64Url(new Uint8Array(sigBuf));
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

export interface ParsedJws {
  readonly header: JwsHeader;
  readonly claims: JwtClaims;
  readonly signingInput: string;
  readonly signature: Uint8Array;
}

/**
 * Split the compact form + base64url-decode header & payload. Does NOT
 * verify — callers run `verifyJwsSignature` separately with the right key.
 * Throws if the three-segment shape is malformed or the b64/JSON is
 * unparseable.
 */
export function parseJws(jws: string): ParsedJws {
  if (typeof jws !== "string" || jws.length === 0) {
    throw new TypeError("parseJws: expected non-empty string");
  }
  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new TypeError("parseJws: compact JWS must have three segments");
  }
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  const headerJson = new TextDecoder().decode(base64UrlToBytes(headerB64));
  const payloadJson = new TextDecoder().decode(base64UrlToBytes(payloadB64));
  const header = JSON.parse(headerJson) as unknown;
  const claims = JSON.parse(payloadJson) as unknown;
  if (!isJwsHeader(header)) {
    throw new TypeError("parseJws: header missing or has unsupported alg");
  }
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    throw new TypeError("parseJws: claims not a JSON object");
  }
  const claimsObj = claims as Record<string, unknown>;
  if (typeof claimsObj.iss !== "string" || claimsObj.iss.length === 0) {
    throw new TypeError("parseJws: claims missing required `iss`");
  }
  const signature = base64UrlToBytes(sigB64);
  return {
    header,
    claims: claimsObj as unknown as JwtClaims,
    signingInput: `${headerB64}.${payloadB64}`,
    signature,
  };
}

export async function verifyJwsSignature(
  parsed: ParsedJws,
  publicKey: CryptoKey,
): Promise<boolean> {
  return crypto.subtle.verify(
    "Ed25519",
    publicKey,
    parsed.signature,
    stringToUtf8(parsed.signingInput),
  );
}

function isJwsHeader(v: unknown): v is JwsHeader {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return obj.alg === "EdDSA";
}
