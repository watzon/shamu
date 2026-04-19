/**
 * Helper for `shamu doctor`'s `audit_events` chain verification.
 *
 * Opens the workspace SQLite DB (same state-dir precedence as `shamu run`
 * via `openRunDatabase`), reads the audit HMAC secret from the OS keychain
 * (same `service`/`account` as `@shamu/persistence`'s `loadOrCreateAuditSecret`
 * — but *read-only* so a missing secret is a `fail` rather than a silent
 * generate+store), walks the chain, and reports the first mismatch.
 *
 * Branches:
 *   - table missing (fresh workspace) → `todo` "no audit_events table"
 *   - keychain unreachable / secret missing → `fail` with onboarding hint
 *   - zero rows → `pass` with "0 rows"
 *   - mismatch → `fail` with seq=<N> + precise reason
 *   - clean → `pass` with "N rows verified"
 *
 * This module is injectable: the real `openRunDatabase` + `createCredentialStore`
 * wiring is the default, but the exported `auditChainCheck({ deps })` accepts
 * overrides so tests can feed in an in-memory DB + `InMemoryStore` without
 * spawning subprocesses.
 */

import { auditQueries, type ShamuDatabase } from "@shamu/persistence";
import type { CredentialStore } from "@shamu/shared/credentials";
import { createCredentialStore } from "@shamu/shared/credentials";
import { isErr } from "@shamu/shared/result";
import { openRunDatabase } from "./run-db.ts";

export interface AuditChainCheckDeps {
  readonly openDatabase: () => ShamuDatabase;
  readonly getCredentialStore: () => CredentialStore;
}

export interface AuditChainCheckResult {
  readonly status: "pass" | "fail" | "todo";
  readonly ok: boolean;
  readonly detail: string;
}

const AUDIT_SECRET_SERVICE = "shamu";
const AUDIT_SECRET_ACCOUNT = "audit-hmac-secret";

/**
 * Default dependency set — what the real CLI entry uses. Tests replace this
 * wholesale via the `deps` arg.
 */
function defaultDeps(): AuditChainCheckDeps {
  return {
    openDatabase: () => openRunDatabase(),
    getCredentialStore: () => createCredentialStore(),
  };
}

/**
 * True if the given DB has an `audit_events` table. The schema ships with
 * migrations; a fresh state dir opened before `shamu run` first-boot hasn't
 * applied them yet.
 */
function hasAuditTable(db: ShamuDatabase): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_events'")
    .get() as { name: string } | undefined;
  return row !== undefined && row.name === "audit_events";
}

export async function auditChainCheck(
  deps: AuditChainCheckDeps = defaultDeps(),
): Promise<AuditChainCheckResult> {
  let db: ShamuDatabase | null = null;
  try {
    try {
      db = deps.openDatabase();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        status: "fail",
        ok: false,
        detail: `cannot open workspace DB: ${message}`,
      };
    }

    if (!hasAuditTable(db)) {
      return {
        status: "todo",
        ok: true,
        detail: "no audit_events table; run `bun shamu run` once to apply migrations",
      };
    }

    // Quick row-count pre-check — avoids a keychain prompt on empty DBs.
    const countRow = db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as
      | { n: number }
      | undefined;
    const rowCount = countRow?.n ?? 0;
    if (rowCount === 0) {
      return { status: "pass", ok: true, detail: "0 rows" };
    }

    let store: CredentialStore;
    try {
      store = deps.getCredentialStore();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        status: "fail",
        ok: false,
        detail: `keychain unreachable: ${message}`,
      };
    }

    let secretHex: string | null;
    try {
      secretHex = await store.get(AUDIT_SECRET_SERVICE, AUDIT_SECRET_ACCOUNT);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        status: "fail",
        ok: false,
        detail: `keychain read failed: ${message}`,
      };
    }
    if (secretHex === null || secretHex.length === 0) {
      return {
        status: "fail",
        ok: false,
        detail:
          "audit secret not in keychain; run shamu doctor --init-audit-secret (Phase 8.C follow-up)",
      };
    }

    const secret = Buffer.from(secretHex, "hex");
    if (secret.length === 0) {
      return {
        status: "fail",
        ok: false,
        detail: "audit secret in keychain is empty or not valid hex",
      };
    }

    const result = auditQueries.verifyAuditChain({ db, secret });
    if (isErr(result)) {
      const err = result.error;
      const seq = err.rowSeq;
      const seqPart = typeof seq === "number" ? `seq=${seq}: ` : "";
      return {
        status: "fail",
        ok: false,
        detail: `${seqPart}${err.message}`,
      };
    }

    return {
      status: "pass",
      ok: true,
      detail: `${rowCount} row${rowCount === 1 ? "" : "s"} verified`,
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // best-effort close — doctor already has its result.
      }
    }
  }
}
