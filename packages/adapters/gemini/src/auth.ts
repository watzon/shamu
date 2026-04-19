/**
 * Gemini ACP auth.
 *
 * Gemini's ACP surface advertises a generic `authenticate` method (not a
 * vendor-prefixed method id — this is the Gemini delta vs Cursor's
 * `cursor_login`). The protocol-acp client's `authenticate(method, params)`
 * wraps the params as `{ methodId: method, ...params }` for the JSON-RPC
 * call; we pass `"authenticate"` as the methodId and the API key as a
 * `params.apiKey` field.
 *
 * Shamu supports four sources in order of precedence (env-first is the
 * non-interactive usage pattern; Gemini CLI accepts either env name):
 *
 *   1. `vendorOpts.apiKey` — direct from the caller.
 *   2. `GEMINI_API_KEY` env — Gemini's canonical env var.
 *   3. `GOOGLE_AI_API_KEY` env — Gemini CLI also accepts this alias.
 *   4. Skip auth — the user is expected to have run `gemini /login` or
 *      `gemini` interactively so the CLI's keychain-backed credential is
 *      already persisted.
 *
 * Typed `GeminiAuthError` wraps ACP RPC errors so callers can branch on it
 * without catching the raw `AcpRpcError` from `@shamu/protocol-acp`.
 *
 * ### Spec note
 *
 * The exact shape of the `authenticate` params is not documented in
 * `geminicli.com/docs/cli/acp-mode/` (verified 2026-04-18 via the phase-7
 * transport spike). We pass `{ apiKey }` inline — if Gemini CLI requires
 * a different key name in the future, narrow this module.
 *
 * ### Persist-back
 *
 * V1 does NOT persist the resolved key through `@shamu/shared/credentials`.
 * A followup (Phase 7.G) can wire per-vendor credential persistence once
 * the other four ACP/stream-JSON adapters have stabilized their auth
 * surfaces.
 */

import { AdapterError } from "@shamu/adapters-base";
import { type AcpClient, AcpRpcError } from "@shamu/protocol-acp";

/** Thrown on auth registration failure. Carries a typed `.code` for the CLI. */
export class GeminiAuthError extends AdapterError {
  public readonly code = "gemini_auth_failed" as const;
}

export interface GeminiAuthOptions {
  /** Gemini API key. Preferred over env when set. */
  readonly apiKey?: string;
}

/**
 * Apply auth to an already-initialized `AcpClient`. MUST be called after
 * `client.initialize(...)` and before the first `session/new`. Returns
 * quietly if no key is found — the caller is trusting that the Gemini CLI
 * is already logged in via `gemini /login`.
 */
export async function applyGeminiAuth(
  client: AcpClient,
  options: GeminiAuthOptions = {},
): Promise<void> {
  const resolved = resolveAuth(options);
  if (!resolved) return;
  try {
    await client.authenticate("authenticate", resolved.params);
  } catch (cause) {
    if (cause instanceof AcpRpcError) {
      throw new GeminiAuthError(
        `Gemini ACP authenticate failed (rpcCode=${cause.rpcCode}): ${cause.message}`,
        cause,
      );
    }
    throw new GeminiAuthError(
      `Gemini ACP authenticate failed: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }
}

/**
 * Resolve auth params from explicit options + env. Exported for tests.
 * Returns `null` when no auth material is found (already-logged-in users).
 */
export function resolveAuth(
  options: GeminiAuthOptions,
): { readonly params: Readonly<Record<string, unknown>>; readonly source: string } | null {
  if (options.apiKey && options.apiKey.length > 0) {
    return { params: { apiKey: options.apiKey }, source: "vendorOpts.apiKey" };
  }
  const envGemini = process.env.GEMINI_API_KEY;
  if (envGemini && envGemini.length > 0) {
    return { params: { apiKey: envGemini }, source: "env:GEMINI_API_KEY" };
  }
  const envGoogle = process.env.GOOGLE_AI_API_KEY;
  if (envGoogle && envGoogle.length > 0) {
    return { params: { apiKey: envGoogle }, source: "env:GOOGLE_AI_API_KEY" };
  }
  return null;
}
