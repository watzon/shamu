/**
 * In-memory fake of `ShamuDatabase` that supports the subset of SQL the web
 * server actually issues: SELECTs over `runs` and `events`. We dispatch on
 * SQL prefix rather than implementing a SQL engine, mirroring the CLI's
 * `test/helpers/fake-db.ts` strategy.
 */

import type { PreparedStatement, ShamuDatabase, SqliteDriver } from "@shamu/persistence";
import type { AgentEvent } from "@shamu/shared/events";

export interface RunRecord {
  run_id: string;
  swarm_id: string | null;
  role: string | null;
  vendor: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface EventRecord {
  event_id: string;
  run_id: string;
  session_id: string | null;
  turn_id: string;
  parent_event_id: string | null;
  seq: number;
  ts_monotonic: number;
  ts_wall: number;
  vendor: string;
  kind: string;
  payload_json: string;
}

export interface FakeDb extends ShamuDatabase {
  addRun(run: RunRecord): void;
  addEvent(event: AgentEvent): void;
  readonly runs: readonly RunRecord[];
  readonly events: readonly EventRecord[];
}

export function createFakeDb(): FakeDb {
  const runs = new Map<string, RunRecord>();
  const events: EventRecord[] = [];

  function addRun(run: RunRecord): void {
    runs.set(run.run_id, run);
  }

  function addEvent(event: AgentEvent): void {
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(event)) {
      if (
        k === "eventId" ||
        k === "runId" ||
        k === "sessionId" ||
        k === "turnId" ||
        k === "parentEventId" ||
        k === "seq" ||
        k === "tsMonotonic" ||
        k === "tsWall" ||
        k === "vendor" ||
        k === "rawRef" ||
        k === "kind"
      ) {
        continue;
      }
      payload[k] = v;
    }
    events.push({
      event_id: event.eventId,
      run_id: event.runId,
      session_id: event.sessionId,
      turn_id: event.turnId,
      parent_event_id: event.parentEventId,
      seq: event.seq,
      ts_monotonic: event.tsMonotonic,
      ts_wall: event.tsWall,
      vendor: event.vendor,
      kind: event.kind,
      payload_json: JSON.stringify(payload),
    });
    events.sort((a, b) => a.seq - b.seq);
  }

  function statement(sql: string): PreparedStatement {
    const trimmed = sql.trim();
    if (trimmed === "SELECT * FROM runs ORDER BY created_at DESC") {
      return {
        run() {
          throw new Error("fake-db: unexpected run()");
        },
        get() {
          throw new Error("fake-db: unexpected get()");
        },
        all() {
          return [...runs.values()].sort((a, b) => b.created_at - a.created_at);
        },
      };
    }
    if (trimmed === "SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC") {
      return {
        run() {
          throw new Error("fake-db: unexpected run()");
        },
        get() {
          throw new Error("fake-db: unexpected get()");
        },
        all(...params: unknown[]) {
          const status = params[0] as string;
          return [...runs.values()]
            .filter((r) => r.status === status)
            .sort((a, b) => b.created_at - a.created_at);
        },
      };
    }
    if (trimmed === "SELECT * FROM runs WHERE run_id = ?") {
      return {
        run() {
          throw new Error("fake-db: unexpected run()");
        },
        get(...params: unknown[]) {
          const id = params[0] as string;
          return runs.get(id) ?? undefined;
        },
        all() {
          throw new Error("fake-db: unexpected all()");
        },
      };
    }
    if (trimmed === "SELECT * FROM events WHERE run_id = ? ORDER BY seq") {
      return {
        run() {
          throw new Error("fake-db: unexpected run()");
        },
        get() {
          throw new Error("fake-db: unexpected get()");
        },
        all(...params: unknown[]) {
          const id = params[0] as string;
          return events.filter((e) => e.run_id === id);
        },
      };
    }
    if (trimmed === "SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?") {
      return {
        run() {
          throw new Error("fake-db: unexpected run()");
        },
        get() {
          throw new Error("fake-db: unexpected get()");
        },
        all(...params: unknown[]) {
          const since = params[0] as number;
          const limit = params[1] as number;
          return events.filter((e) => e.seq > since).slice(0, limit);
        },
      };
    }
    throw new Error(`fake-db: unsupported SQL: ${trimmed.slice(0, 120)}`);
  }

  const driver: SqliteDriver = {
    exec(): void {},
    prepare(sql: string): PreparedStatement {
      return statement(sql);
    },
    transaction<T>(fn: () => T): T {
      return fn();
    },
    close(): void {
      runs.clear();
      events.length = 0;
    },
  };

  const db = {
    path: ":fake:",
    driver,
    prepare(sql: string): PreparedStatement {
      return statement(sql);
    },
    exec(): void {},
    transaction<T>(fn: () => T): T {
      return fn();
    },
    close(): void {
      runs.clear();
      events.length = 0;
    },
    backup(): void {
      throw new Error("fake-db: backup not supported");
    },
    migrations(): readonly { version: number; appliedAt: number; checksum: string }[] {
      return [];
    },
  } satisfies ShamuDatabase;

  return Object.assign(db, {
    addRun,
    addEvent,
    get runs(): readonly RunRecord[] {
      return [...runs.values()];
    },
    get events(): readonly EventRecord[] {
      return [...events];
    },
  });
}
