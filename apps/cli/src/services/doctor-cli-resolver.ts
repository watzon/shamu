/**
 * `shamu doctor --resolve-clis` surface — runs the shared vendor-CLI
 * resolver for every shipped adapter and emits a per-adapter diagnosis.
 *
 * The shape matches the other doctor helpers: each call returns a
 * structured result (`status` + `ok` + `detail`) plus a richer per-
 * adapter list the JSON mode can emit one-event-per-adapter from.
 *
 * Design notes:
 * - Echo is skipped (no vendor CLI; `adapterHasVendorCli` gates it).
 * - Version-probe failures produce a "warn" severity, not a full fail —
 *   the binary IS present; it's just out of the configured range.
 * - We do NOT pass `lastChance` here. Sidecar bootstrap has a network
 *   cost that doctor runs shouldn't pay silently; if the on-disk chain
 *   misses we surface that so the operator can either install the CLI
 *   or run an explicit `shamu run --adapter claude` to trigger the
 *   sidecar.
 */

import {
  resolveVendorCli,
  VendorCliNotFoundError,
  type VendorCliResolverAttempt,
  type VendorCliResolverResult,
  VendorCliVersionMismatchError,
  type VendorName,
} from "@shamu/adapters-base/vendor-cli-resolver";
import type { AdapterConfigEntry, ShamuConfig } from "../config.ts";
import { adapterHasVendorCli, knownAdapterNames } from "./adapters.ts";
import { getVendorCliDescriptor } from "./vendor-cli-registry.ts";

export type CliResolverSeverity = "pass" | "fail" | "warn";

export interface CliResolverAdapterResult {
  readonly adapter: VendorName;
  readonly severity: CliResolverSeverity;
  readonly ok: boolean;
  readonly path?: string;
  readonly source?: VendorCliResolverResult["source"];
  readonly version?: string;
  readonly constraint?: string;
  readonly detail: string;
  /** Paths checked during resolution, in order. Populated for fail/warn. */
  readonly checked: readonly string[];
}

export interface CliResolverCheckSummary {
  readonly status: "pass" | "fail" | "todo";
  readonly ok: boolean;
  readonly detail: string;
  readonly adapters: readonly CliResolverAdapterResult[];
}

export interface ResolveClisCheckInput {
  readonly config?: ShamuConfig;
  /**
   * Injected env snapshot; defaults to `process.env`. Kept explicit so
   * tests can pin a clean env without mutating globals.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Run the resolver for every adapter that ships with a real CLI. Returns
 * a rolled-up summary plus per-adapter entries.
 */
export async function resolveClisCheck(
  input: ResolveClisCheckInput = {},
): Promise<CliResolverCheckSummary> {
  const adapters = knownAdapterNames().filter(adapterHasVendorCli);
  const results: CliResolverAdapterResult[] = [];

  for (const adapter of adapters) {
    const descriptor = getVendorCliDescriptor(adapter);
    const rawEntry = input.config?.adapters[adapter] as AdapterConfigEntry | undefined;
    const configEntry = narrowConfigEntry(rawEntry);
    try {
      const res = await resolveVendorCli({
        adapter,
        descriptor,
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(configEntry !== undefined ? { configEntry } : {}),
      });
      results.push({
        adapter,
        severity: "pass",
        ok: true,
        path: res.path,
        source: res.source,
        ...(res.version !== undefined ? { version: res.version } : {}),
        detail: `${res.path} (source=${res.source}${res.version ? `, version=${res.version}` : ""})`,
        checked: pathsFromAttempts(res.attempts),
      });
    } catch (err) {
      if (err instanceof VendorCliVersionMismatchError) {
        results.push({
          adapter,
          severity: "warn",
          ok: false,
          path: err.path,
          ...(err.version !== null ? { version: err.version } : {}),
          constraint: err.constraint,
          detail: `binary at ${err.path} version ${err.version ?? "unknown"} outside constraint ${err.constraint}`,
          checked: [err.path],
        });
        continue;
      }
      if (err instanceof VendorCliNotFoundError) {
        results.push({
          adapter,
          severity: "fail",
          ok: false,
          detail: `not found (checked ${err.attempts.length} location(s))`,
          checked: pathsFromAttempts(err.attempts),
        });
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        adapter,
        severity: "fail",
        ok: false,
        detail: `resolver threw: ${message}`,
        checked: [],
      });
    }
  }

  const failed = results.filter((r) => r.severity === "fail");
  const warned = results.filter((r) => r.severity === "warn");
  const detail =
    failed.length === 0 && warned.length === 0
      ? `all ${results.length} adapter CLI(s) resolved`
      : failed.length > 0
        ? `${failed.length} adapter CLI(s) not found, ${warned.length} version-mismatch(es)`
        : `${warned.length} adapter CLI(s) outside their configured version range`;

  return {
    status: failed.length > 0 ? "fail" : "pass",
    ok: failed.length === 0,
    detail,
    adapters: results,
  };
}

function pathsFromAttempts(attempts: readonly VendorCliResolverAttempt[]): string[] {
  return attempts
    .map((a) => a.path)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}

/**
 * Adapt `AdapterConfigEntry` (optional-or-undefined fields) to the
 * resolver's strict-shape input under `exactOptionalPropertyTypes`.
 */
function narrowConfigEntry(
  entry: AdapterConfigEntry | undefined,
): { cliPath?: string; cliVersionConstraint?: string } | undefined {
  if (entry === undefined) return undefined;
  const out: { cliPath?: string; cliVersionConstraint?: string } = {};
  if (entry.cliPath !== undefined) out.cliPath = entry.cliPath;
  if (entry.cliVersionConstraint !== undefined) {
    out.cliVersionConstraint = entry.cliVersionConstraint;
  }
  return out;
}
