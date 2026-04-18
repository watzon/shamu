/**
 * Branded IDs.
 *
 * Every ID type is a nominal brand over `string`. The runtime value is
 * always a plain string, so JSON, SQLite, and stream boundaries pass them
 * through without ceremony. The brand only affects TypeScript call sites.
 *
 * All factory functions validate that the input is non-empty. ULID-shaped
 * factories additionally verify the Crockford base32 format so that a
 * truncated/typo'd ID trips immediately, rather than later when a DB lookup
 * returns nothing.
 */

import { isUlid, ulid } from "./ulid.ts";

// The brand technique: a phantom symbol-typed property. The `unique symbol`
// keys ensure every brand is distinct, and because they never exist at
// runtime, they impose zero overhead.
declare const __brand: unique symbol;
type Brand<T, Tag extends string> = T & { readonly [__brand]: Tag };

export type RunId = Brand<string, "RunId">;
export type SessionId = Brand<string, "SessionId">;
export type EventId = Brand<string, "EventId">;
export type TurnId = Brand<string, "TurnId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type LeaseId = Brand<string, "LeaseId">;
export type SwarmId = Brand<string, "SwarmId">;
export type WorkflowRunId = Brand<string, "WorkflowRunId">;
export type AuditEventId = Brand<string, "AuditEventId">;

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requireUlid(value: string, name: string): void {
  requireNonEmpty(value, name);
  if (!isUlid(value)) {
    throw new TypeError(`${name} must be a ULID (26 Crockford base32 chars)`);
  }
}

// --- Factories that wrap an existing string (validation only) ---

export function runId(value: string): RunId {
  requireNonEmpty(value, "RunId");
  return value as RunId;
}

/**
 * Parse an unknown string into a {@link RunId}. Throws `TypeError` when the
 * input is not a non-empty string — matches the `runId()` factory's validation
 * but accepts `unknown` so callers can parse arbitrary payloads (e.g. event
 * buses, node outputs) without a prior `as string` cast.
 *
 * Prefer this over `as RunId` when narrowing a `string`/`unknown` value from
 * outside the branded-type world. If the caller only has a confirmed `string`
 * and wants a cast-free brand, use {@link runId} instead.
 */
export function parseRunId(input: unknown): RunId {
  if (typeof input !== "string") {
    throw new TypeError(
      `RunId must be a non-empty string, got ${input === null ? "null" : typeof input}`,
    );
  }
  return runId(input);
}

export function sessionId(value: string): SessionId {
  requireNonEmpty(value, "SessionId");
  return value as SessionId;
}

export function eventId(value: string): EventId {
  requireUlid(value, "EventId");
  return value as EventId;
}

export function turnId(value: string): TurnId {
  requireNonEmpty(value, "TurnId");
  return value as TurnId;
}

export function toolCallId(value: string): ToolCallId {
  requireNonEmpty(value, "ToolCallId");
  return value as ToolCallId;
}

export function leaseId(value: string): LeaseId {
  requireNonEmpty(value, "LeaseId");
  return value as LeaseId;
}

export function swarmId(value: string): SwarmId {
  requireNonEmpty(value, "SwarmId");
  return value as SwarmId;
}

export function workflowRunId(value: string): WorkflowRunId {
  requireNonEmpty(value, "WorkflowRunId");
  return value as WorkflowRunId;
}

export function auditEventId(value: string): AuditEventId {
  requireUlid(value, "AuditEventId");
  return value as AuditEventId;
}

// --- Factories that generate a fresh ULID-backed ID ---

export function newRunId(): RunId {
  return ulid() as RunId;
}

export function newSessionId(): SessionId {
  return ulid() as SessionId;
}

export function newEventId(): EventId {
  return ulid() as EventId;
}

export function newTurnId(): TurnId {
  return ulid() as TurnId;
}

export function newToolCallId(): ToolCallId {
  return ulid() as ToolCallId;
}

export function newLeaseId(): LeaseId {
  return ulid() as LeaseId;
}

export function newSwarmId(): SwarmId {
  return ulid() as SwarmId;
}

export function newWorkflowRunId(): WorkflowRunId {
  return ulid() as WorkflowRunId;
}

export function newAuditEventId(): AuditEventId {
  return ulid() as AuditEventId;
}
