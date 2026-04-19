/**
 * Amp auth.
 *
 * Amp authenticates via either:
 *
 *   (a) `AMP_API_KEY` env var (non-interactive, preferred for CI + shamu).
 *   (b) Pre-ran `amp login` (the Amp CLI persists the token in the OS
 *       keychain via `@napi-rs/keyring` — shamu doesn't read this; amp
 *       picks it up itself on spawn).
 *
 * Shamu's `applyAmpAuth` is a pure, side-effect-free resolver: given the
 * options, it decides which env var to inject into the spawn environment.
 * The actual injection happens at subprocess spawn time (see `driver.ts`'s
 * `defaultEnv`); this module is the policy that feeds it.
 *
 * Precedence:
 *   1. `options.apiKey` (explicit, from caller / orchestrator).
 *   2. `AMP_API_KEY` env var already set on the parent process.
 *   3. Skip — rely on `amp login`'s keychain credential. Returns `null`.
 *
 * We do NOT persist the resolved key anywhere. The env var is written only
 * into the spawn env (never into `process.env`, never into a config file).
 */

import { AdapterError } from "@shamu/adapters-base";

/** Thrown on auth registration failure. Carries a typed `.code` for the CLI. */
export class AmpAuthError extends AdapterError {
  public readonly code = "amp_auth_failed" as const;
}

export interface AmpAuthOptions {
  /** Direct API key (preferred over env). */
  readonly apiKey?: string;
}

export interface ResolvedAmpAuth {
  /**
   * When set, the caller should inject `AMP_API_KEY=<value>` into the
   * spawn env. When null, the caller skips — amp resolves credentials via
   * its own keychain integration.
   */
  readonly apiKey: string | null;
  /**
   * Human-readable provenance string ("vendorOpts.apiKey", "env:AMP_API_KEY",
   * "keychain"). Surfaced in logs + `shamu doctor` output; never in events.
   */
  readonly source: string;
}

/**
 * Resolve auth precedence. Pure function; exported for tests.
 *
 * Returns a typed resolution even when there's no explicit key — in that
 * case `.apiKey === null` and the caller is trusting `amp login`.
 */
export function applyAmpAuth(options: AmpAuthOptions = {}): ResolvedAmpAuth {
  if (options.apiKey !== undefined) {
    if (typeof options.apiKey !== "string") {
      throw new AmpAuthError("AmpAuth: apiKey must be a string when provided");
    }
    if (options.apiKey.length === 0) {
      throw new AmpAuthError(
        "AmpAuth: apiKey was provided but empty — either omit it or set a non-empty value",
      );
    }
    return { apiKey: options.apiKey, source: "vendorOpts.apiKey" };
  }
  const envKey = process.env.AMP_API_KEY;
  if (envKey && envKey.length > 0) {
    return { apiKey: envKey, source: "env:AMP_API_KEY" };
  }
  return { apiKey: null, source: "keychain" };
}
