/**
 * Small fixture builders used across the server route tests.
 */

import type { AgentEvent } from "@shamu/shared/events";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function mkUlid(n: number): string {
  // Fabricate a 26-char ULID-shaped string. Only the regex shape matters for
  // the schema; the monotonic-prefix property isn't required for these tests.
  const base = n.toString(36).toUpperCase().padStart(26, "0");
  // Replace illegal chars (ULID's Crockford alphabet excludes I/L/O/U).
  const cleaned = base.replace(/[ILOU]/g, "0");
  if (!ULID_RE.test(cleaned)) {
    throw new Error(`fixture: could not produce a ULID-shaped id for ${n}: ${cleaned}`);
  }
  return cleaned;
}

export function makeEvent(
  partial: Partial<AgentEvent> & { seq: number; runId: string },
): AgentEvent {
  const base = {
    eventId: partial.eventId ?? mkUlid(partial.seq + 1),
    runId: partial.runId,
    sessionId: partial.sessionId ?? null,
    turnId: partial.turnId ?? "turn-1",
    parentEventId: partial.parentEventId ?? null,
    seq: partial.seq,
    tsMonotonic: partial.tsMonotonic ?? partial.seq,
    tsWall: partial.tsWall ?? 1_700_000_000_000 + partial.seq,
    vendor: partial.vendor ?? "echo",
    rawRef: partial.rawRef ?? null,
  };
  const kind = partial.kind ?? "assistant_delta";
  if (kind === "assistant_delta") {
    return {
      ...base,
      kind: "assistant_delta",
      text: (partial as { text?: string }).text ?? `chunk ${partial.seq}`,
    };
  }
  if (kind === "session_start") {
    return {
      ...base,
      kind: "session_start",
      source: (partial as { source?: "spawn" | "resume" | "fork" }).source ?? "spawn",
    };
  }
  throw new Error(`fixture: unsupported kind ${kind}`);
}
