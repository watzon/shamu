/**
 * CSRF protection for the dashboard's mutating endpoints.
 *
 * The dashboard is 127.0.0.1-bound, single-user — but a malicious page the
 * user is browsing in another tab can still issue cross-origin requests to
 * `http://127.0.0.1:<port>/api/runs`. The Origin allow-list is the first
 * line; CSRF tokens are the second.
 *
 * ## Double-submit cookie pattern
 *
 * 1. Client calls `GET /api/csrf`. We mint a random token, set it as a
 *    `shamu_csrf` cookie (Path=/, SameSite=Strict, HttpOnly=false — the
 *    SPA needs to read it to echo back), and return it in the body.
 * 2. On every mutation (`POST`/`PUT`/`PATCH`/`DELETE`) the client sends
 *    BOTH the cookie (automatic) AND an `X-CSRF-Token` header. If the two
 *    match, the request passes; otherwise 403.
 *
 * The cookie is NOT HttpOnly on purpose — a cross-origin page can't read
 * it (CORS blocks that), but the same-origin SPA can. Security relies on
 * the Origin allow-list that fires before this check: cross-origin
 * requests are already 403'd by the time CSRF matters. This is a defense
 * in depth for the `curl`/fetch-with-stripped-Origin edge.
 *
 * Tokens are per-process and rotate every boot — no persistence, no
 * rotation schedule. Single-user fits the threat model.
 */

import type { Context } from "hono";

/** 32 random bytes, base64url-encoded — ~43 chars. */
const TOKEN_BYTES = 32;

/**
 * Mint a fresh CSRF token. Uses Web Crypto's `getRandomValues` so it
 * works under Bun + Node 20+.
 */
export function mintCsrfToken(): string {
  const buf = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

/** Constant-time compare — avoids timing-based token probing. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a.charCodeAt(i) ^ b.charCodeAt(i)) & 0xff;
  }
  return diff === 0;
}

/** Name of the cookie + header pair. */
export const CSRF_COOKIE_NAME = "shamu_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

/**
 * Serialize a `Set-Cookie` string for our token cookie. Kept as a plain
 * helper so the Hono route can stamp the header directly.
 */
export function buildCsrfCookie(token: string): string {
  return [
    `${CSRF_COOKIE_NAME}=${token}`,
    "Path=/",
    "SameSite=Strict",
    // deliberately NOT HttpOnly — the SPA reads this to echo back.
    // deliberately NOT Secure — localhost HTTP.
  ].join("; ");
}

/** Extract the CSRF cookie value from a Cookie header. Returns null if absent. */
export function parseCsrfCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader || cookieHeader.length === 0) return null;
  for (const segment of cookieHeader.split(/;\s*/)) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const name = segment.slice(0, eq).trim();
    if (name === CSRF_COOKIE_NAME) {
      return segment.slice(eq + 1).trim();
    }
  }
  return null;
}

/** Result of validating a mutating request. */
export type CsrfValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "missing-cookie" | "missing-header" | "mismatch" };

/**
 * Verify the double-submit cookie + header match. Pure; caller decides
 * how to map to an HTTP response.
 */
export function validateCsrf(c: Context): CsrfValidation {
  const cookieVal = parseCsrfCookie(c.req.header("cookie"));
  const headerVal = c.req.header(CSRF_HEADER_NAME);
  if (cookieVal === null || cookieVal.length === 0) return { ok: false, reason: "missing-cookie" };
  if (headerVal === undefined || headerVal.length === 0)
    return { ok: false, reason: "missing-header" };
  return safeEqual(cookieVal, headerVal) ? { ok: true } : { ok: false, reason: "mismatch" };
}

// --- internals -----------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  // Browser + Bun + Node all expose btoa on globalThis; fall back to
  // Buffer.from for the Node-under-Vitest edge.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  const base64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
