/**
 * OpenCode BYO-provider-key auth.
 *
 * OpenCode is transport-only: the server delegates LLM calls to a configured
 * provider (Anthropic, OpenAI, etc.). Each provider is keyed by its OpenCode
 * provider id (`"anthropic"`, `"openai"`, `"google"`, ...). The SDK exposes
 * `client.auth.set({ path: { id }, body: { type: "api", key } })` to
 * provision a key.
 *
 * Shamu's credential convention: a service+account pair lives in the OS
 * keychain via `@shamu/shared/credentials`. Callers resolve the key through
 * that abstraction and pass it to `applyOpencodeAuth()` below.
 *
 * We do NOT hardcode provider ids here — the caller tells us which provider
 * to configure. An orchestrator that fans a single run out across multiple
 * providers calls `applyOpencodeAuth` once per provider.
 *
 * ### No silent fallback
 *
 * If a caller passes a key that doesn't match any registered provider on the
 * server, the SDK surfaces a 400 and we propagate it as an `OpencodeAuthError`.
 * No retry, no silent fallback — the operator has mis-configured and needs
 * to see it.
 */

import { AdapterError } from "@shamu/adapters-base";
import type { CredentialStore } from "@shamu/shared/credentials";
import type { OpencodeSdkClient } from "./driver.ts";

/** Thrown on auth registration failure. Carries a typed `.code` for the CLI. */
export class OpencodeAuthError extends AdapterError {
  public readonly code = "opencode_auth_failed" as const;
}

export interface ApplyOpencodeAuthOptions {
  /** Provider id as registered with the OpenCode server (e.g. "anthropic"). */
  readonly providerId: string;
  /** API key material. Prefer a keychain lookup — never hard-code. */
  readonly apiKey: string;
}

/**
 * Register `providerId` -> `apiKey` with the OpenCode server behind `client`.
 * Returns quietly on success; throws `OpencodeAuthError` on any SDK error.
 */
export async function applyOpencodeAuth(
  client: OpencodeSdkClient,
  options: ApplyOpencodeAuthOptions,
): Promise<void> {
  if (!options.providerId) {
    throw new OpencodeAuthError("providerId is required");
  }
  if (!options.apiKey) {
    throw new OpencodeAuthError("apiKey is required");
  }
  try {
    const res = await client.auth.set({
      path: { id: options.providerId },
      body: { type: "api", key: options.apiKey },
    });
    if (res.data !== true) {
      throw new OpencodeAuthError(
        `OpenCode auth.set did not return success for provider ${options.providerId}`,
      );
    }
  } catch (cause) {
    if (cause instanceof OpencodeAuthError) throw cause;
    throw new OpencodeAuthError(
      `OpenCode auth.set failed for provider ${options.providerId}: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }
}

/**
 * Resolve an API key from the shared credential store and apply it. The
 * credential service/account convention mirrors `@shamu/linear-client`:
 * service = `"shamu.opencode"`, account = `providerId`. Callers that
 * want a different convention (per-env, per-swarm) pass `service` +
 * `account` explicitly.
 */
export interface ResolveAndApplyOptions {
  readonly store: CredentialStore;
  readonly providerId: string;
  /** Defaults to `"shamu.opencode"`. */
  readonly service?: string;
  /** Defaults to `providerId`. */
  readonly account?: string;
}

export async function resolveAndApplyOpencodeAuth(
  client: OpencodeSdkClient,
  options: ResolveAndApplyOptions,
): Promise<void> {
  const service = options.service ?? "shamu.opencode";
  const account = options.account ?? options.providerId;
  const apiKey = await options.store.get(service, account);
  if (!apiKey) {
    throw new OpencodeAuthError(
      `No API key found in credential store for service=${service} account=${account} (provider=${options.providerId})`,
    );
  }
  await applyOpencodeAuth(client, { providerId: options.providerId, apiKey });
}
