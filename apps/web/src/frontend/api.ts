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
