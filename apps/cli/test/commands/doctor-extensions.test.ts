/**
 * Unit tests for Phase 8.C's new `shamu doctor` helpers.
 *
 * Each helper is tested via its injected-deps seams:
 *   - `auditChainCheck` — fake in-memory `ShamuDatabase` + `InMemoryStore`
 *   - `egressBrokerCheck` — real in-process broker on a random port
 *   - `clockSkewCheck` — injected `ntpQuery` fake + a stubbed `env` for
 *     the disabled-by-env path
 *   - `webhookServerCheck` — real tiny Node HTTP server for the pass case,
 *     closed server for the `todo` refusal path
 *   - `tunnelScopeCheck` — temp file with pass-shape + fail-shape configs
 *
 * Nothing here spawns a subprocess; the existing `commands.test.ts` covers
 * the subprocess JSON-shape expectations (it asserts `>3` lines and each
 * line parses — the new checks are additive, so that assertion still holds).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparedStatement, ShamuDatabase, SqliteDriver } from "@shamu/persistence";
import { InMemoryStore } from "@shamu/shared/credentials";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditChainCheck } from "../../src/services/doctor-audit-chain.ts";
import { clockSkewCheck } from "../../src/services/doctor-clock.ts";
import { egressBrokerCheck } from "../../src/services/doctor-egress.ts";
import { tunnelScopeCheck } from "../../src/services/doctor-tunnel-scope.ts";
import { webhookServerCheck } from "../../src/services/doctor-webhook.ts";

// ---------------------------------------------------------------------------
// Fake ShamuDatabase — satisfies the subset of queries the audit-chain check
// and `verifyAuditChain` actually reach for.
// ---------------------------------------------------------------------------

interface AuditRow {
  audit_event_id: string;
  seq: number;
  actor: string;
  action: string;
  entity: string;
  reason: string;
  ts: number;
  payload_json: string;
  prev_hmac: string;
  row_hmac: string;
}

interface FakeAuditDbOptions {
  readonly includeTable: boolean;
  readonly rows: AuditRow[];
}

function createFakeAuditDb(opts: FakeAuditDbOptions): ShamuDatabase {
  const rows = opts.rows;

  function statement(sql: string): PreparedStatement {
    const trimmed = sql.trim();
    if (/sqlite_master/i.test(trimmed)) {
      return {
        get(): unknown {
          return opts.includeTable ? { name: "audit_events" } : undefined;
        },
        run(): unknown {
          return undefined;
        },
        all(): unknown[] {
          return [];
        },
      };
    }
    if (/COUNT\(\*\)/i.test(trimmed)) {
      return {
        get(): unknown {
          return { n: rows.length };
        },
        run(): unknown {
          return undefined;
        },
        all(): unknown[] {
          return [];
        },
      };
    }
    if (trimmed.startsWith("SELECT * FROM audit_events")) {
      return {
        get(): unknown {
          return rows[0];
        },
        run(): unknown {
          return undefined;
        },
        all(...params: unknown[]): unknown[] {
          if (params.length === 2) {
            const [fromSeq, toSeq] = params as [number, number];
            return rows.filter((r) => r.seq >= fromSeq && r.seq <= toSeq);
          }
          return [...rows];
        },
      };
    }
    if (trimmed.startsWith("SELECT row_hmac FROM audit_events WHERE seq")) {
      return {
        get(...params: unknown[]): unknown {
          const [seq] = params as [number];
          const found = rows.find((r) => r.seq === seq);
          return found ? { row_hmac: found.row_hmac } : undefined;
        },
        run(): unknown {
          return undefined;
        },
        all(): unknown[] {
          return [];
        },
      };
    }
    throw new Error(`fake-audit-db: unexpected SQL: ${trimmed}`);
  }

  const driver: SqliteDriver = {
    exec(): void {},
    prepare: statement,
    transaction<T>(fn: () => T): T {
      return fn();
    },
    close(): void {},
  };

  return {
    path: "(fake)",
    driver,
    exec: () => undefined,
    prepare: statement,
    transaction<T>(fn: () => T): T {
      return fn();
    },
    close(): void {},
    backup(): void {
      throw new Error("fake-audit-db: backup not supported");
    },
    migrations(): never {
      throw new Error("fake-audit-db: migrations() not supported");
    },
  };
}

// ---------------------------------------------------------------------------
// Helper — precompute HMAC-chained rows. Mirrors `appendAudit`'s chain build
// but in-memory (no bun:sqlite required).
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function canonicalEntryJson(entry: {
  actor: string;
  action: string;
  entity: string;
  reason: string;
  ts: number;
  payload: Record<string, unknown>;
}): string {
  return canonicalJson({
    actor: entry.actor,
    action: entry.action,
    entity: entry.entity,
    payload: entry.payload,
    reason: entry.reason,
    ts: entry.ts,
  });
}

async function hmacRow(
  secret: Buffer,
  seq: number,
  prevHmac: string,
  entryJson: string,
): Promise<string> {
  const { createHmac } = await import("node:crypto");
  const mac = createHmac("sha256", secret);
  mac.update(String(seq));
  mac.update("\n");
  mac.update(prevHmac);
  mac.update("\n");
  mac.update(entryJson);
  return mac.digest("hex");
}

async function buildChain(secret: Buffer, count: number): Promise<AuditRow[]> {
  const out: AuditRow[] = [];
  let prev = "0".repeat(64);
  for (let seq = 0; seq < count; seq++) {
    const entry = {
      actor: "supervisor",
      action: "run.start",
      entity: `run:${seq}`,
      reason: "scheduled",
      ts: 1_700_000_000_000 + seq,
      payload: { seq },
    };
    const canonical = canonicalEntryJson(entry);
    const rowHmac = await hmacRow(secret, seq, prev, canonical);
    // `payload_json` persists only the payload object (not the full canonical
    // entry) — `verifyAuditChain` re-canonicalizes the full entry from the
    // row's columns + parsed `payload_json`.
    out.push({
      audit_event_id: `id-${seq}`,
      seq,
      actor: entry.actor,
      action: entry.action,
      entity: entry.entity,
      reason: entry.reason,
      ts: entry.ts,
      payload_json: JSON.stringify(entry.payload),
      prev_hmac: prev,
      row_hmac: rowHmac,
    });
    prev = rowHmac;
  }
  return out;
}

const AUDIT_SECRET_SERVICE = "shamu";
const AUDIT_SECRET_ACCOUNT = "audit-hmac-secret";

async function seedSecret(store: InMemoryStore, secret: Buffer): Promise<void> {
  await store.set(AUDIT_SECRET_SERVICE, AUDIT_SECRET_ACCOUNT, secret.toString("hex"));
}

// ---------------------------------------------------------------------------
// auditChainCheck
// ---------------------------------------------------------------------------

describe("auditChainCheck", () => {
  it("returns `todo` when audit_events table is missing", async () => {
    const store = new InMemoryStore();
    const db = createFakeAuditDb({ includeTable: false, rows: [] });
    const result = await auditChainCheck({
      openDatabase: () => db,
      getCredentialStore: () => store,
    });
    expect(result.status).toBe("todo");
    expect(result.detail).toMatch(/no audit_events table/);
  });

  it("returns `pass` with '0 rows' on an empty but present table", async () => {
    const store = new InMemoryStore();
    const db = createFakeAuditDb({ includeTable: true, rows: [] });
    const result = await auditChainCheck({
      openDatabase: () => db,
      getCredentialStore: () => store,
    });
    expect(result.status).toBe("pass");
    expect(result.detail).toBe("0 rows");
  });

  it("returns `fail` when the keychain is missing the audit secret", async () => {
    const store = new InMemoryStore();
    const rows = await buildChain(Buffer.from("deadbeef".repeat(8), "hex"), 1);
    const db = createFakeAuditDb({ includeTable: true, rows });
    const result = await auditChainCheck({
      openDatabase: () => db,
      getCredentialStore: () => store,
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/audit secret not in keychain/);
  });

  it("returns `pass` for a valid 3-row chain", async () => {
    const secret = Buffer.alloc(32, 0x11);
    const rows = await buildChain(secret, 3);
    const store = new InMemoryStore();
    await seedSecret(store, secret);
    const db = createFakeAuditDb({ includeTable: true, rows });
    const result = await auditChainCheck({
      openDatabase: () => db,
      getCredentialStore: () => store,
    });
    expect(result.status).toBe("pass");
    expect(result.detail).toMatch(/3 rows verified/);
  });

  it("returns `fail` with seq=2 when row 2 is tampered", async () => {
    const secret = Buffer.alloc(32, 0x22);
    const rows = await buildChain(secret, 3);
    // Tamper the payload of row 2 post-hoc: its stored row_hmac still reflects
    // the original payload, so recomputation will diverge at seq=2.
    const row2 = rows[2];
    if (!row2) throw new Error("setup");
    row2.payload_json = JSON.stringify({ seq: 999 });
    const store = new InMemoryStore();
    await seedSecret(store, secret);
    const db = createFakeAuditDb({ includeTable: true, rows });
    const result = await auditChainCheck({
      openDatabase: () => db,
      getCredentialStore: () => store,
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("seq=2");
  });
});

// ---------------------------------------------------------------------------
// egressBrokerCheck
// ---------------------------------------------------------------------------

describe("egressBrokerCheck", () => {
  it("passes in under 2s: broker denies a bogus CONNECT", async () => {
    const t0 = Date.now();
    const result = await egressBrokerCheck();
    const elapsed = Date.now() - t0;
    expect(result.status).toBe("pass");
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  }, 5_000);
});

// ---------------------------------------------------------------------------
// clockSkewCheck
// ---------------------------------------------------------------------------

describe("clockSkewCheck", () => {
  it("returns `todo` when $SHAMU_DOCTOR_NO_NTP=1", async () => {
    const result = await clockSkewCheck({
      env: { SHAMU_DOCTOR_NO_NTP: "1" } as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe("todo");
    expect(result.detail).toMatch(/disabled/);
  });

  it("returns `pass` when injected NTP is within 5s", async () => {
    const now = 1_700_000_000_000;
    const result = await clockSkewCheck({
      env: {} as NodeJS.ProcessEnv,
      now: () => now,
      ntpQuery: async () => ({ ok: true, ntpMs: now + 2_000 }),
    });
    expect(result.status).toBe("pass");
    expect(result.detail).toMatch(/skew=2s/);
  });

  it("returns `fail` when injected NTP is more than 5s off", async () => {
    const now = 1_700_000_000_000;
    const result = await clockSkewCheck({
      env: {} as NodeJS.ProcessEnv,
      now: () => now,
      ntpQuery: async () => ({ ok: true, ntpMs: now + 8_000 }),
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/skew=8s/);
  });

  it("returns `todo` when injected NTP times out", async () => {
    const result = await clockSkewCheck({
      env: {} as NodeJS.ProcessEnv,
      ntpQuery: async () => ({ ok: false, reason: "timeout" }),
      timeoutMs: 250,
    });
    expect(result.status).toBe("todo");
    expect(result.detail).toMatch(/unreachable/);
  });
});

// ---------------------------------------------------------------------------
// webhookServerCheck
// ---------------------------------------------------------------------------

describe("webhookServerCheck", () => {
  it("returns `todo` when no env is set and no port was provided", async () => {
    const result = await webhookServerCheck({
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe("todo");
    expect(result.detail).toMatch(/no daemon detected/);
  });

  it("returns `todo` when nothing is listening on the explicit port", async () => {
    // Grab a free port, let the socket close, then try to probe it.
    const server = createHttpServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as AddressInfo;
    await new Promise<void>((r) => server.close(() => r()));
    const result = await webhookServerCheck({ port: addr.port, timeoutMs: 750 });
    expect(result.status).toBe("todo");
    expect(result.detail).toMatch(/no daemon listening/);
  });

  it("returns `pass` when /webhooks/linear responds 200 + { status: 'ok' }", async () => {
    const server = createHttpServer((req, res) => {
      if (req.url === "/webhooks/linear") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as AddressInfo;
    try {
      const result = await webhookServerCheck({ port: addr.port, timeoutMs: 1_500 });
      expect(result.status).toBe("pass");
      expect(result.detail).toMatch(/daemon ok/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("returns `fail` when /webhooks/linear returns a non-200 status", async () => {
    const server = createHttpServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as AddressInfo;
    try {
      const result = await webhookServerCheck({ port: addr.port, timeoutMs: 1_500 });
      expect(result.status).toBe("fail");
      expect(result.detail).toMatch(/HTTP 500/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ---------------------------------------------------------------------------
// tunnelScopeCheck
// ---------------------------------------------------------------------------

describe("tunnelScopeCheck", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-tunnel-scope-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns `todo` when no CLOUDFLARED_CONFIG_PATH is set", () => {
    const result = tunnelScopeCheck({ env: {} as NodeJS.ProcessEnv });
    expect(result.status).toBe("todo");
    expect(result.detail).toMatch(/no CLOUDFLARED_CONFIG_PATH/);
  });

  it("returns `pass` when every service points at the webhook port", () => {
    const path = join(dir, "config.yml");
    writeFileSync(
      path,
      [
        "tunnel: shamu-test",
        "ingress:",
        "  - hostname: shamu.example.com",
        "    service: http://localhost:7357",
        "  - service: http_status:404",
        "",
      ].join("\n"),
    );
    const result = tunnelScopeCheck({
      configPath: path,
      webhookPort: 7357,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe("pass");
    expect(result.detail).toMatch(/1 service/);
  });

  it("returns `fail` when a service leaks the dashboard port", () => {
    const path = join(dir, "config.yml");
    writeFileSync(
      path,
      [
        "tunnel: shamu-test",
        "ingress:",
        "  - hostname: shamu.example.com",
        "    service: http://localhost:7357",
        "  - hostname: shamu-ui.example.com",
        "    service: http://127.0.0.1:4711",
        "  - service: http_status:404",
        "",
      ].join("\n"),
    );
    const result = tunnelScopeCheck({
      configPath: path,
      webhookPort: 7357,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/4711/);
  });

  it("returns `fail` when the config path is unreadable", () => {
    const result = tunnelScopeCheck({
      configPath: join(dir, "does-not-exist.yml"),
      webhookPort: 7357,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/cannot read/);
  });

  it("returns `pass` when the config has no localhost services", () => {
    const path = join(dir, "config.yml");
    writeFileSync(
      path,
      ["tunnel: shamu-test", "ingress:", "  - service: http_status:404", ""].join("\n"),
    );
    const result = tunnelScopeCheck({
      configPath: path,
      webhookPort: 7357,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe("pass");
    expect(result.detail).toMatch(/no localhost services/);
  });
});
