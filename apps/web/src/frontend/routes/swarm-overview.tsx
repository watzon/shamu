/**
 * Swarm overview — clickable table of runs from `/api/runs`.
 *
 * No live subscription at the overview level in the MVP; we just refresh on
 * mount. A polling loop can be added in a follow-on PR once the real-time
 * story for the overview table is decided (SSE per-row vs one tail channel).
 */

import { A } from "@solidjs/router";
import { createResource, For, Show } from "solid-js";
import { fetchRuns, type RunSummary } from "../api.ts";
import { formatTimestamp } from "../format.ts";

export function SwarmOverview() {
  const [runs, { refetch }] = createResource<readonly RunSummary[]>(fetchRuns);
  return (
    <section class="runs-view">
      <header class="runs-view__header">
        <h1>Runs</h1>
        <button type="button" class="btn" onClick={() => refetch()}>
          refresh
        </button>
      </header>
      <Show when={!runs.loading} fallback={<p class="runs-view__loading">loading runs…</p>}>
        <Show when={runs.error}>
          <p class="runs-view__error">could not load runs: {String(runs.error)}</p>
        </Show>
        <Show when={(runs() ?? []).length === 0 && !runs.error}>
          <p class="runs-view__empty">no runs yet — start one from the CLI.</p>
        </Show>
        <Show when={(runs() ?? []).length > 0}>
          <table class="runs-table">
            <thead>
              <tr>
                <th>run id</th>
                <th>swarm</th>
                <th>role</th>
                <th>vendor</th>
                <th>status</th>
                <th>created</th>
                <th>updated</th>
              </tr>
            </thead>
            <tbody>
              <For each={runs() ?? []}>
                {(r) => (
                  <tr class="runs-table__row">
                    <td>
                      <A class="runs-table__runid" href={`/run/${encodeURIComponent(r.runId)}`}>
                        {r.runId}
                      </A>
                    </td>
                    <td class="muted">{r.swarmId ?? "—"}</td>
                    <td class="muted">{r.role ?? "—"}</td>
                    <td class="muted">{r.vendor ?? "—"}</td>
                    <td>
                      <span class={`status status--${r.status}`}>{r.status}</span>
                    </td>
                    <td class="muted mono">{formatTimestamp(r.createdAt)}</td>
                    <td class="muted mono">{formatTimestamp(r.updatedAt)}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </Show>
    </section>
  );
}
