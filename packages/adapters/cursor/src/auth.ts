/**
 * Cursor ACP auth.
 *
 * Cursor's ACP surface advertises a single auth method id, `cursor_login`.
 * The client's side of the round trip is:
 *
 *   client → `authenticate` with `methodId: "cursor_login"` and the key
 *            material as params (`{ apiKey }` or `{ authToken }`).
 *   server  → success (already-logged-in users can skip this entirely;
 *            Cursor Desktop's `cursor-agent login` persists a token).
 *
 * Shamu supports four sources in order of precedence:
 *
 *   1. `vendorOpts.apiKey` — direct from the caller (test or programmatic
 *      driver). Maps to `authenticate("cursor_login", { apiKey })`.
 *   2. `vendorOpts.authToken` — Cursor's subscription token path.
 *   3. `CURSOR_API_KEY` env.
 *   4. `CURSOR_AUTH_TOKEN` env.
 *   5. Skip auth — ACP `initialize` works for already-logged-in users
 *      (Cursor's desktop app persists a token in the OS keychain; we
 *      accept that as a pre-condition).
 *
 * Typed `CursorAuthError` wraps ACP RPC errors so callers can branch on it
 * without catching the raw `AcpRpcError` from `@shamu/protocol-acp`.
 *
 * ### Spec gap
 *
 * The exact request shape for `cursor_login` is not documented in
 * `cursor.com/docs/cli/acp` (verified 2026-04-18). We pass both shapes
 * inline so the agent can pick whichever key it finds; the fallback source
 * (Cursor Desktop's persisted token) covers users who haven't exported an
 * API key. If the Cursor team documents a stricter shape, the adapter
 * README note in `docs/phase-7/*` should be updated and this module
 * narrowed.
 */

import { AdapterError } from "@shamu/adapters-base";
import { type AcpClient, AcpRpcError } from "@shamu/protocol-acp";

/** Thrown on auth registration failure. Carries a typed `.code` for the CLI. */
export class CursorAuthError extends AdapterError {
  public readonly code = "cursor_auth_failed" as const;
}

export interface CursorAuthOptions {
  /** Cursor API key. Preferred over token when both are set. */
  readonly apiKey?: string;
  /** Cursor subscription auth token. */
  readonly authToken?: string;
}

/**
 * Apply auth to an already-initialized `AcpClient`. MUST be called after
 * `client.initialize(...)` and before the first `session/new`. Returns
 * quietly if neither explicit params nor env variables set a key — the
 * caller is trusting that the agent is already logged in.
 */
export async function applyCursorAuth(
  client: AcpClient,
  options: CursorAuthOptions = {},
): Promise<void> {
  const resolved = resolveAuth(options);
  if (!resolved) return;
  try {
    await client.authenticate("cursor_login", resolved.params);
  } catch (cause) {
    if (cause instanceof AcpRpcError) {
      throw new CursorAuthError(
        `Cursor ACP authenticate failed (rpcCode=${cause.rpcCode}): ${cause.message}`,
        cause,
      );
    }
    throw new CursorAuthError(
      `Cursor ACP authenticate failed: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }
}

/**
 * Resolve auth params from explicit options + env. Exported for tests.
 * Returns `null` when no auth material is found (already-logged-in users).
 */
export function resolveAuth(
  options: CursorAuthOptions,
): { readonly params: Readonly<Record<string, unknown>>; readonly source: string } | null {
  if (options.apiKey && options.apiKey.length > 0) {
    return { params: { apiKey: options.apiKey }, source: "vendorOpts.apiKey" };
  }
  if (options.authToken && options.authToken.length > 0) {
    return { params: { authToken: options.authToken }, source: "vendorOpts.authToken" };
  }
  const envApiKey = process.env.CURSOR_API_KEY;
  if (envApiKey && envApiKey.length > 0) {
    return { params: { apiKey: envApiKey }, source: "env:CURSOR_API_KEY" };
  }
  const envAuthToken = process.env.CURSOR_AUTH_TOKEN;
  if (envAuthToken && envAuthToken.length > 0) {
    return { params: { authToken: envAuthToken }, source: "env:CURSOR_AUTH_TOKEN" };
  }
  return null;
}
