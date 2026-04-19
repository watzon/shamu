/**
 * Tests for the screenshot seed helper.
 *
 * We exercise it against the `createFakeDb` in-memory SQL-dispatch fake so the
 * test doesn't depend on `bun:sqlite` being loadable in Vitest workers (the
 * same constraint the route tests honor — see apps/web/test/routes.test.ts).
 *
 * The real capture script uses `openDatabase` (real SQLite) for determinism
 * reasons, but the seed helper's *behavior* is exercised here against the
 * fake: it issues the expected INSERT statements through the DB's `prepare()`
 * surface regardless of driver.
 */

import { describe, expect, it } from "vitest";
import { mkUlid, seedScreenshotFixtures } from "./screenshot-seed.ts";

// Lightweight recording DB that captures the prepared SQL + params. We don't
// use `fake-db.ts` here because `insertRun` / `insertEvent` drive INSERT
// statements the fake deliberately doesn't handle (it only covers SELECTs the
// route tests exercise). A minimal fake suffices to pin the helper's
// contract.
interface RecordedCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function makeRecordingDb(): {
  db: Parameters<typeof seedScreenshotFixtures>[0];
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const driver = {
    exec() {},
    prepare(sql: string) {
      return {
        run(...params: unknown[]): unknown {
          calls.push({ sql, params });
          return undefined;
        },
        get(): unknown {
          return undefined;
        },
        all(): unknown[] {
          return [];
        },
      };
    },
    transaction<T>(fn: () => T): T {
      return fn();
    },
    close() {},
  };
  const db = {
    path: ":recording:",
    driver,
    exec() {},
    prepare(sql: string) {
      return driver.prepare(sql);
    },
    transaction<T>(fn: () => T): T {
      return fn();
    },
    close() {},
    backup() {
      throw new Error("recording-db: backup not supported");
    },
    migrations() {
      return [];
    },
  };
  return { db, calls };
}

describe("mkUlid", () => {
  it("produces 26 Crockford base32 chars", () => {
    const id = mkUlid("RUN", 42);
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is deterministic for a given (prefix, n)", () => {
    expect(mkUlid("RUN", 1)).toBe(mkUlid("RUN", 1));
  });

  it("varies with n", () => {
    expect(mkUlid("RUN", 1)).not.toBe(mkUlid("RUN", 2));
  });
});

describe("seedScreenshotFixtures", () => {
  it("inserts one run per requested count plus events for each", () => {
    const { db, calls } = makeRecordingDb();
    const result = seedScreenshotFixtures(db, { runCount: 2, eventsPerRun: 6 });
    expect(result.runs).toHaveLength(2);
    for (const run of result.runs) {
      expect(run.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(run.swarmId).toBe(result.swarmId);
    }
    const runInserts = calls.filter((c) => c.sql.startsWith("INSERT INTO runs"));
    const eventInserts = calls.filter((c) => c.sql.startsWith("INSERT OR IGNORE INTO events"));
    expect(runInserts).toHaveLength(2);
    // Each run should have at minimum: session_start, assistant_message,
    // tool_call, tool_result, usage, turn_end = 6.
    expect(eventInserts.length).toBeGreaterThanOrEqual(12);
  });

  it("uses the same base time so successive runs produce identical state", () => {
    const a = makeRecordingDb();
    const b = makeRecordingDb();
    seedScreenshotFixtures(a.db, { runCount: 1, eventsPerRun: 6 });
    seedScreenshotFixtures(b.db, { runCount: 1, eventsPerRun: 6 });
    expect(a.calls.map((c) => c.sql)).toEqual(b.calls.map((c) => c.sql));
    expect(a.calls.map((c) => c.params)).toEqual(b.calls.map((c) => c.params));
  });

  it("clamps event count to the safe range", () => {
    const { db, calls } = makeRecordingDb();
    seedScreenshotFixtures(db, { runCount: 1, eventsPerRun: 999 });
    // Even with an absurd request, the helper shouldn't emit an unbounded
    // insert list — the skeleton caps at 20 slots.
    const events = calls.filter((c) => c.sql.startsWith("INSERT OR IGNORE INTO events"));
    expect(events.length).toBeLessThanOrEqual(21);
  });

  it("defaults to two runs when runCount is omitted", () => {
    const { db } = makeRecordingDb();
    const result = seedScreenshotFixtures(db);
    expect(result.runs).toHaveLength(2);
  });
});
