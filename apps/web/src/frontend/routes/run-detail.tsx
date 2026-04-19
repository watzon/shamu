/**
 * Run detail — run header + chronological event list, live via SSE.
 *
 * Subscription strategy:
 *   1. Fetch `/api/runs/:id` for the run row + the full event history so
 *      first paint has everything the DB already knows about.
 *   2. Open an `EventSource` against `/api/runs/:id/stream`. On each
 *      `agent_event` message, append to the list and track the highest
 *      `seq` we've seen so reconnects resume cleanly.
 *
 * The browser handles Last-Event-ID automatically on reconnect — we set
 * `id` on each SSE message (seq number) and the server reads the header.
 */

import type { AgentEvent } from "@shamu/shared/events";
import { A, useParams } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { fetchRunDetail, type RunDetailPayload, runStreamUrl } from "../api.ts";
import { formatTimestamp, truncate } from "../format.ts";

type ConnectionState = "idle" | "connecting" | "open" | "error" | "closed";

export function RunDetail() {
  const params = useParams<{ id: string }>();
  const [detail] = createResource<RunDetailPayload, string>(() => params.id, fetchRunDetail);
  const [liveEvents, setLiveEvents] = createSignal<readonly AgentEvent[]>([]);
  const [connection, setConnection] = createSignal<ConnectionState>("idle");
  const [connectError, setConnectError] = createSignal<string | null>(null);

  const allEvents = createMemo(() => {
    const base = detail()?.events ?? [];
    // Dedupe by eventId — the SSE stream may replay events we already pulled
    // via the initial fetch if tailEvents returns overlapping seq ranges
    // (it shouldn't, but belt and braces).
    const seen = new Set<string>();
    const out: AgentEvent[] = [];
    for (const ev of [...base, ...liveEvents()]) {
      if (seen.has(ev.eventId)) continue;
      seen.add(ev.eventId);
      out.push(ev);
    }
    return out;
  });

  createEffect(() => {
    const d = detail();
    if (!d) return;
    const url = runStreamUrl(d.run.runId);
    setConnection("connecting");
    setConnectError(null);
    const source = new EventSource(url);
    source.addEventListener("open", () => setConnection("open"));
    source.addEventListener("agent_event", (ev) => {
      try {
        const parsed = JSON.parse((ev as MessageEvent).data) as AgentEvent;
        setLiveEvents((prev) => [...prev, parsed]);
      } catch (err) {
        setConnectError(`malformed SSE payload: ${String(err)}`);
      }
    });
    source.addEventListener("error", () => {
      // EventSource will reconnect on its own; surface the transient state
      // rather than treating it as fatal.
      setConnection("error");
    });
    onCleanup(() => {
      source.close();
      setConnection("closed");
    });
  });

  return (
    <section class="run-view">
      <header class="run-view__header">
        <A href="/" class="run-view__back">
          ← all runs
        </A>
        <Show when={detail()} fallback={<h1>loading…</h1>}>
          {(d) => (
            <div class="run-view__headline">
              <h1 class="run-view__runid">{d().run.runId}</h1>
              <div class="run-view__meta">
                <span class={`status status--${d().run.status}`}>{d().run.status}</span>
                <span class="muted">vendor: {d().run.vendor ?? "—"}</span>
                <span class="muted">role: {d().run.role ?? "—"}</span>
                <span class="muted">swarm: {d().run.swarmId ?? "—"}</span>
                <span class="muted mono">created {formatTimestamp(d().run.createdAt)}</span>
              </div>
            </div>
          )}
        </Show>
        <ConnectionIndicator state={connection()} />
      </header>
      <Show when={connectError()}>
        <p class="run-view__error">{connectError()}</p>
      </Show>
      <Show when={detail.error}>
        <p class="run-view__error">could not load run: {String(detail.error)}</p>
      </Show>
      <Show when={detail()}>
        <div class="events">
          <For each={allEvents()}>{(ev) => <EventRow event={ev} />}</For>
          <Show when={allEvents().length === 0}>
            <p class="events__empty">no events yet — waiting for live tail…</p>
          </Show>
        </div>
      </Show>
    </section>
  );
}

function ConnectionIndicator(props: { state: ConnectionState }) {
  const label = () => {
    switch (props.state) {
      case "idle":
        return "idle";
      case "connecting":
        return "connecting";
      case "open":
        return "live";
      case "error":
        return "reconnecting";
      case "closed":
        return "closed";
    }
  };
  return (
    <span class={`connection connection--${props.state}`} role="status" aria-live="polite">
      <span class="connection__dot" aria-hidden="true" />
      {label()}
    </span>
  );
}

function EventRow(props: { event: AgentEvent }) {
  const summary = createMemo(() => summarize(props.event));
  return (
    <article class="event">
      <div class="event__head">
        <span class="event__seq">#{props.event.seq}</span>
        <span class="event__kind">{props.event.kind}</span>
        <span class="muted mono event__time">{formatTimestamp(props.event.tsWall)}</span>
        <span class="muted event__vendor">{props.event.vendor}</span>
      </div>
      <Show when={summary()}>
        <p class="event__summary">{summary()}</p>
      </Show>
    </article>
  );
}

function summarize(event: AgentEvent): string {
  switch (event.kind) {
    case "assistant_message":
    case "assistant_delta":
    case "reasoning":
    case "stdout":
    case "stderr":
      return truncate(event.text, 200);
    case "tool_call":
      return `${event.tool} (${event.toolCallId})`;
    case "tool_result":
      return `${event.toolCallId}: ${event.ok ? "ok" : "failed"} — ${truncate(event.summary, 160)}`;
    case "permission_request":
      return `${event.toolCallId}: ${event.decision}`;
    case "patch_applied":
      return `${event.files.length} file(s), +${event.stats.add}/-${event.stats.del}`;
    case "checkpoint":
      return truncate(event.summary, 200);
    case "usage":
      return `${event.model}: in=${event.tokens.input} out=${event.tokens.output}`;
    case "cost":
      return event.usd === null
        ? `cost (${event.confidence})`
        : `$${event.usd.toFixed(4)} (${event.confidence})`;
    case "rate_limit":
      return `${event.scope}: ${event.status}`;
    case "interrupt":
      return `by ${event.requestedBy}${event.delivered ? "" : " (pending)"}`;
    case "turn_end":
      return `${event.stopReason} in ${event.durationMs}ms`;
    case "error":
      return `${event.errorCode}: ${truncate(event.message, 160)}`;
    case "session_start":
      return `source: ${event.source}`;
    case "session_end":
      return `reason: ${event.reason}`;
  }
}
