/**
 * Frontend API client. Mirrors the shapes the Hono app returns — intentionally
 * duplicated as structural types rather than re-exported from persistence, to
 * avoid pulling `bun:sqlite` into the browser bundle.
 */

import type { AgentEvent } from "@shamu/shared/events";

export interface RunSummary {
  readonly runId: string;
  readonly swarmId: string | null;
  readonly role: string | null;
  readonly vendor: string | null;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RunDetailPayload {
  readonly run: RunSummary;
  readonly events: readonly AgentEvent[];
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function fetchRuns(): Promise<readonly RunSummary[]> {
  const payload = await getJson<{ readonly runs: readonly RunSummary[] }>("/api/runs");
  return payload.runs;
}

export async function fetchRunDetail(id: string): Promise<RunDetailPayload> {
  return getJson<RunDetailPayload>(`/api/runs/${encodeURIComponent(id)}`);
}

export function runStreamUrl(id: string): string {
  return `/api/runs/${encodeURIComponent(id)}/stream`;
}

// --- Phase 9.C control surface ------------------------------------------

export interface AdapterAvailability {
  readonly vendor: string;
  readonly ok: boolean;
  readonly path?: string;
  readonly source?: string;
  readonly version?: string;
  readonly error?: string;
}

export interface ModelInfo {
  readonly id: string;
  readonly label: string;
  readonly default?: boolean;
}

export async function fetchAvailableAdapters(): Promise<readonly AdapterAvailability[]> {
  const payload = await getJson<{ readonly adapters: readonly AdapterAvailability[] }>(
    "/api/adapters/available",
  );
  return payload.adapters;
}

export async function fetchAdapterModels(vendor: string): Promise<readonly ModelInfo[]> {
  const payload = await getJson<{ readonly models: readonly ModelInfo[] }>(
    `/api/adapters/${encodeURIComponent(vendor)}/models`,
  );
  return payload.models;
}

export interface CsrfToken {
  readonly token: string;
  readonly cookie: string;
}

export async function fetchCsrfToken(): Promise<CsrfToken> {
  return getJson<CsrfToken>("/api/csrf");
}

export type StartRunResponse =
  | { readonly ok: true; readonly runId: string; readonly url: string }
  | {
      readonly ok: false;
      readonly code: "vendor-cli-not-found";
      readonly adapter: string;
      readonly checked: readonly string[];
      readonly message: string;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface StartRunInput {
  readonly task: string;
  readonly adapter: string;
  readonly role: string;
  readonly model?: string;
  readonly flow?: string;
}

/**
 * POST /api/runs with CSRF. Mints a fresh token every call — cheap
 * (in-process) and keeps the flow stateless on the client side.
 */
export async function startRun(input: StartRunInput): Promise<StartRunResponse> {
  const csrf = await fetchCsrfToken();
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrf.token,
    },
    body: JSON.stringify(input),
    credentials: "same-origin",
  });
  const body = (await res.json()) as StartRunResponse;
  return body;
}

/**
 * POST /api/runs/:id/interrupt — cooperatively cancel a run. Returns the
 * server's status field on success, null on any failure.
 */
export async function interruptRun(runId: string): Promise<"cancelled" | null> {
  const csrf = await fetchCsrfToken();
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/interrupt`, {
    method: "POST",
    headers: { "x-csrf-token": csrf.token },
    credentials: "same-origin",
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { ok?: boolean; status?: string };
  return body.status === "cancelled" ? "cancelled" : null;
}
