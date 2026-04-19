/**
 * Pi auth — placeholder module.
 *
 * Pi is configured via its own `pi login` interactive flow (per provider)
 * and/or provider-specific environment variables:
 *
 *   - `ANTHROPIC_API_KEY` when Pi is configured for Claude
 *   - `OPENAI_API_KEY`    for OpenAI / compatible
 *   - `GOOGLE_AI_API_KEY` / `GEMINI_API_KEY` for Gemini
 *   - `GROQ_API_KEY`, `CEREBRAS_API_KEY`, etc. for other provider SDKs Pi
 *     supports.
 *
 * For v1 of this adapter we **do not manage Pi auth in-process**. The
 * reasoning:
 *
 * 1. Pi has its own persisted provider config on disk (typically under
 *    `~/.config/pi-coding-agent/` or similar). Running `pi login <provider>`
 *    in a shell session is the documented entry point; the adapter should
 *    not replicate that surface.
 * 2. Pi's RPC protocol (as of `pi --mode rpc` docs fetched 2026-04-18) does
 *    NOT expose a `login` / `auth.set` command. We could shell out to
 *    `pi login` at spawn time but that would require a TTY and leaks into
 *    user-interactive territory that shamu's non-interactive daemon cannot
 *    own.
 * 3. Shamu's credential store (`@shamu/shared/credentials`) can still be
 *    wired up later — a future `resolvePiAuth()` can forward keys via
 *    the subprocess env (see `driver.defaultEnv`, which already allow-lists
 *    the common provider env-var names).
 *
 * Until then, the contract is: the operator has either run `pi login`
 * once, or has a provider API key in the environment that `defaultEnv`
 * forwards to the subprocess.
 *
 * `PiAuthError` is exported so the eventual Phase 8 auth-integration PR
 * has a stable throwable to surface through the adapter's error stream.
 * Today, no call site throws it.
 */

export { PiAuthError } from "./errors.ts";
