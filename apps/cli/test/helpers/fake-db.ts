/**
 * Minimal in-memory stand-in for a `ShamuDatabase` that the flow runner
 * can insert / update `flow_runs` rows through during unit tests.
 *
 * The real `flow-runs.ts` uses `db.prepare(sql).run(...)` / `.get(...)`.
 * We satisfy `ShamuDatabase` with a `prepare` that dispatches on the SQL
 * text (the query module uses four constant statements); anything else
 * throws so test drift is caught immediately.
 */

import type { PreparedStatement, ShamuDatabase, SqliteDriver } from "@shamu/persistence";

interface Row {
  flow_run_id: string;
  flow_id: string;
  dag_version: number;
  status: string;
  state_json: string;
  resumed_from: string | null;
  started_at: number;
  updated_at: number;
}

export interface FakeFlowDb extends ShamuDatabase {
  readonly rows: ReadonlyArray<Row>;
  getRow(flowRunId: string): Row | null;
}

export function createFakeFlowDb(): FakeFlowDb {
  const rows = new Map<string, Row>();

  function statement(sql: string): PreparedStatement {
    const trimmed = sql.trim();
    if (trimmed.startsWith("INSERT INTO flow_runs")) {
      return {
        run(...params: unknown[]): unknown {
          const [
            flow_run_id,
            flow_id,
            dag_version,
            status,
            state_json,
            resumed_from,
            started_at,
            updated_at,
          ] = params as [string, string, number, string, string, string | null, number, number];
          rows.set(flow_run_id, {
            flow_run_id,
            flow_id,
            dag_version,
            status,
            state_json,
            resumed_from,
            started_at,
            updated_at,
          });
          return { changes: 1, lastInsertRowid: 1 };
        },
        get(): unknown {
          throw new Error("fake-db: insert prepared statement did not expect .get");
        },
        all(): unknown[] {
          throw new Error("fake-db: insert prepared statement did not expect .all");
        },
      };
    }
    if (trimmed.startsWith("UPDATE flow_runs")) {
      return {
        run(...params: unknown[]): unknown {
          const [status, state_json, updated_at, flow_run_id] = params as [
            string,
            string,
            number,
            string,
          ];
          const prior = rows.get(flow_run_id);
          if (!prior) return { changes: 0, lastInsertRowid: 0 };
          rows.set(flow_run_id, { ...prior, status, state_json, updated_at });
          return { changes: 1, lastInsertRowid: 0 };
        },
        get(): unknown {
          throw new Error("fake-db: update prepared statement did not expect .get");
        },
        all(): unknown[] {
          throw new Error("fake-db: update prepared statement did not expect .all");
        },
      };
    }
    if (trimmed.startsWith("SELECT") && trimmed.includes("FROM flow_runs")) {
      return {
        run(): unknown {
          throw new Error("fake-db: select prepared statement did not expect .run");
        },
        get(...params: unknown[]): unknown {
          const flowRunId = params[0] as string;
          return rows.get(flowRunId) ?? null;
        },
        all(): unknown[] {
          return [...rows.values()];
        },
      };
    }
    throw new Error(`fake-db: unsupported SQL: ${trimmed.slice(0, 80)}`);
  }

  const driver: SqliteDriver = {
    exec(_sql: string): void {
      // No-op: the flow runner never calls exec.
    },
    prepare(sql: string): PreparedStatement {
      return statement(sql);
    },
    close(): void {
      rows.clear();
    },
    transaction<T>(fn: () => T): T {
      return fn();
    },
  };

  const shamuDb = {
    path: ":fake:",
    driver,
    prepare(sql: string): PreparedStatement {
      return statement(sql);
    },
    exec(_sql: string): void {
      // no-op
    },
    transaction<T>(fn: () => T): T {
      return fn();
    },
    close(): void {
      rows.clear();
    },
    backup(_destPath: string): void {
      throw new Error("fake-db: backup not supported");
    },
    migrations(): readonly { version: number; appliedAt: number; checksum: string }[] {
      return [];
    },
  } satisfies ShamuDatabase;

  const api: FakeFlowDb = Object.assign(shamuDb, {
    get rows(): ReadonlyArray<Row> {
      return [...rows.values()];
    },
    getRow(id: string): Row | null {
      return rows.get(id) ?? null;
    },
  });
  return api;
}
