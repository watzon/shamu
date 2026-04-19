/**
 * Deterministic seed for the screenshot-capture script.
 *
 * This helper is deliberately placed under `apps/web/test/helpers/` alongside
 * the existing test fixtures (`fake-db.ts` / `fixtures.ts`), but unlike those
 * it is wired against a REAL `ShamuDatabase` (opened via `@shamu/persistence`)
 * rather than the in-memory dispatch-on-SQL fake. The screenshot script boots
 * `startServer()` which opens SQLite through `openDatabase`, so the seed has
 * to go through the real schema path.
 *
 * Why not reuse `fixtures.ts`?
 * --------------------------
 * `makeEvent()` only emits `assistant_delta` and `session_start` kinds — fine
 * for route tests, but produces a dull-looking run detail page. The screenshot
 * needs a visibly varied event list (tool calls, assistant messages, usage,
 * turn_end) to convince a reviewer that the UI renders non-trivial content.
 *
 * Determinism
 * -----------
 * IDs, timestamps, and textual content are all derived from a fixed numeric
 * index so successive runs produce byte-identical DBs. This keeps screenshots
 * reproducible (modulo font rendering and browser version).
 */

import { eventsQueries, runsQueries, type ShamuDatabase } from "@shamu/persistence";
import type { AgentEvent } from "@shamu/shared/events";
import {
  eventId as brandEventId,
  runId as brandRunId,
  swarmId as brandSwarmId,
} from "@shamu/shared/ids";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Fabricate a 26-char ULID-shaped id deterministically from a numeric index.
 * Only the regex shape matters for the schema — the monotonic-prefix property
 * isn't required for screenshots.
 */
export function mkUlid(prefix: string, n: number): string {
  const padded = n
    .toString(32)
    .toUpperCase()
    .padStart(26 - prefix.length, "0");
  const tail = padded.replace(/[ILOU]/g, "0");
  const raw = `${prefix.toUpperCase()}${tail}`.slice(0, 26);
  // Replace any char outside Crockford base32 with "0".
  let cleaned = "";
  for (const ch of raw) {
    cleaned += ULID_ALPHABET.includes(ch) ? ch : "0";
  }
  return cleaned.padEnd(26, "0");
}

export interface SeededRun {
  readonly runId: string;
  readonly swarmId: string;
  readonly eventCount: number;
}

export interface SeedResult {
  readonly swarmId: string;
  readonly runs: readonly SeededRun[];
}

export interface SeedOptions {
  /**
   * Number of runs to create. Defaults to 2. The first run gets a richer
   * event list (session_start → tool calls → assistant messages → turn_end);
   * subsequent runs mirror the shape with fewer events so the overview table
   * has visible variety.
   */
  readonly runCount?: number;
  /**
   * How many events per run. Defaults to 7. Clamped to [2, 20].
   */
  readonly eventsPerRun?: number;
  /**
   * Deterministic base timestamp for the `createdAt` / `tsWall` fields.
   * Defaults to `1_700_000_000_000` (2023-11-14T22:13:20Z) so screenshots
   * show a stable "created" column.
   */
  readonly baseTimeMs?: number;
}

/**
 * Seed the given database with a deterministic swarm + N runs + per-run events.
 * Returns the IDs so the caller can build screenshot URLs.
 */
export function seedScreenshotFixtures(db: ShamuDatabase, opts: SeedOptions = {}): SeedResult {
  const runCount = Math.max(1, Math.min(5, opts.runCount ?? 2));
  const eventsPerRun = Math.max(2, Math.min(20, opts.eventsPerRun ?? 7));
  const baseTimeMs = opts.baseTimeMs ?? 1_700_000_000_000;

  const swarmId = brandSwarmId(mkUlid("SW", 1));
  const vendors: readonly string[] = ["claude", "codex", "echo", "cursor", "opencode"];
  const roles: readonly string[] = ["executor", "reviewer", "planner"];
  const statuses: readonly ("running" | "completed" | "failed" | "review")[] = [
    "completed",
    "running",
    "review",
    "failed",
    "completed",
  ];

  const seededRuns: SeededRun[] = [];

  for (let i = 0; i < runCount; i++) {
    const runId = brandRunId(mkUlid("RUN", i + 1));
    const vendor = vendors[i % vendors.length] ?? "echo";
    const role = roles[i % roles.length] ?? "executor";
    const status = statuses[i % statuses.length] ?? "completed";
    const createdAt = baseTimeMs + i * 60_000;

    runsQueries.insertRun(db, {
      runId,
      swarmId,
      role,
      vendor,
      status,
      createdAt,
    });

    // Determinstic event ladder. The shape mirrors a short tool-using turn:
    // session_start → assistant_message → tool_call → tool_result → usage → turn_end
    // Extra slots (up to eventsPerRun) are filled with assistant_delta chunks.
    const events = buildEventLadder({
      runId,
      vendor,
      baseTimeMs: createdAt,
      count: eventsPerRun,
    });
    for (const ev of events) {
      eventsQueries.insertEvent(db, ev);
    }

    seededRuns.push({ runId, swarmId, eventCount: events.length });
  }

  return { swarmId, runs: seededRuns };
}

interface BuildEventsInput {
  readonly runId: string;
  readonly vendor: string;
  readonly baseTimeMs: number;
  readonly count: number;
}

function buildEventLadder(input: BuildEventsInput): readonly AgentEvent[] {
  const { runId, vendor, baseTimeMs, count } = input;
  const turnId = mkUlid("TRN", 1);
  const toolCallId = `call-${runId.slice(-6).toLowerCase()}-1`;
  const envelope = (seq: number, extras: { parentEventId?: string | null } = {}) => ({
    eventId: brandEventId(mkUlid(`E${seq}`, baseTimeMs + seq)),
    runId,
    sessionId: null,
    turnId,
    parentEventId:
      extras.parentEventId === undefined ? null : (extras.parentEventId as unknown as null),
    seq,
    tsMonotonic: seq,
    tsWall: baseTimeMs + seq * 1_000,
    vendor,
    rawRef: null,
  });

  const out: AgentEvent[] = [];
  // Fixed skeleton events — always present for visual variety.
  out.push({
    ...envelope(0),
    kind: "session_start",
    source: "spawn",
  });
  out.push({
    ...envelope(1),
    kind: "assistant_message",
    text: "Reading the repository layout and planning next steps.",
    stopReason: "end_turn",
  });
  out.push({
    ...envelope(2),
    kind: "tool_call",
    toolCallId,
    tool: "Read",
    args: { path: "PLAN.md" },
  });
  out.push({
    ...envelope(3),
    kind: "tool_result",
    toolCallId,
    ok: true,
    summary: "PLAN.md (4128 bytes) — architecture + phased delivery",
    bytes: 4128,
  });
  // Fill remaining slots with assistant_delta chunks so long lists look real.
  for (let seq = 4; seq < count - 2 && seq < 20; seq++) {
    out.push({
      ...envelope(seq),
      kind: "assistant_delta",
      text: `chunk ${seq}: drafting changes to the capture pipeline…`,
    });
  }
  const usageSeq = out.length;
  out.push({
    ...envelope(usageSeq),
    kind: "usage",
    model: "claude-opus-4-7",
    tokens: { input: 1024, output: 512, cacheRead: 256 },
    cache: { hits: 4, misses: 1 },
  });
  const turnEndSeq = out.length;
  out.push({
    ...envelope(turnEndSeq),
    kind: "turn_end",
    stopReason: "end_turn",
    durationMs: 4_200,
  });
  return out.slice(0, Math.max(count, 6));
}
