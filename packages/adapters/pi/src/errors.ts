/**
 * Typed errors surfaced by the Pi adapter + RPC client.
 *
 * Every error extends `AdapterError` from `@shamu/adapters-base` so the
 * CLI's code→exit mapping fires and the handle's error-event emission has
 * a stable `.code` to surface. Shapes parallel ACP's error hierarchy (see
 * `packages/protocol/acp/src/errors.ts`) — we do NOT import those classes,
 * because Pi isn't ACP and the protocol package must stay adapter-free.
 */

import { AdapterError } from "@shamu/adapters-base";

/**
 * A line arrived on the incoming stream that wasn't valid Pi RPC JSON, or a
 * response frame was structurally malformed (missing `type`, etc.). Carries
 * the raw line for diagnostics — redaction is the caller's job.
 */
export class PiProtocolError extends AdapterError {
  public readonly code = "pi_protocol" as const;

  /** The raw line or best-effort serialized frame. */
  public readonly raw: string;

  constructor(message: string, raw: string, cause?: unknown) {
    super(message, cause);
    this.raw = raw;
  }
}

/**
 * An outgoing command didn't receive a matching response within the
 * configured window.
 */
export class PiTimeoutError extends AdapterError {
  public readonly code = "pi_timeout" as const;

  public readonly command: string;
  public readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`Pi RPC command timed out after ${timeoutMs}ms: command=${command}`);
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The RPC client was closed (or its transport died) while at least one
 * command was still in-flight. Every pending command rejects with this.
 */
export class PiShutdownError extends AdapterError {
  public readonly code = "pi_shutdown" as const;
}

/**
 * Pi returned a `{type:"response", success: false, error}` envelope. The
 * adapter typically surfaces this as an `error` `AgentEvent`.
 */
export class PiCommandError extends AdapterError {
  public readonly code = "pi_command_error" as const;

  public readonly command: string;

  constructor(command: string, message: string, cause?: unknown) {
    super(`Pi RPC command error (${command}): ${message}`, cause);
    this.command = command;
  }
}

/**
 * Raised when Pi's auth surface is accessed. Pi is BYO-provider-key per
 * provider (`pi login`, provider-specific env) and v1 of the adapter does
 * not manage auth — this exists so a future `applyPiAuth` expansion can
 * throw a stable class. See `auth.ts` for details.
 */
export class PiAuthError extends AdapterError {
  public readonly code = "pi_auth_failed" as const;
}
