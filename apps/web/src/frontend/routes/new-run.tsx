/**
 * `/new-run` — start a new swarm run from the dashboard.
 *
 * Layout:
 *   - task textarea
 *   - adapter dropdown (populated from /api/adapters/available;
 *     unavailable adapters are disabled + show their error)
 *   - model dropdown (populated on adapter change)
 *   - role dropdown (planner | executor | reviewer)
 *   - optional flow-module field (text; defaults to single-adapter path)
 *   - submit → POST /api/runs → navigate to /run/<id>
 *
 * Error surface:
 *   - vendor-cli-not-found shows the full `checked` list + message
 *   - any other failure shows the server's `message` verbatim
 */

import { useNavigate, useSearchParams } from "@solidjs/router";
import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import {
  type AdapterAvailability,
  fetchAdapterModels,
  fetchAvailableAdapters,
  type ModelInfo,
  type StartRunResponse,
  startRun,
} from "../api.ts";

const ROLES = ["executor", "planner", "reviewer"] as const;

export function NewRun() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams<{ resume?: string }>();

  const [adapters] = createResource<readonly AdapterAvailability[]>(fetchAvailableAdapters);
  const [task, setTask] = createSignal<string>("");
  const [selectedAdapter, setSelectedAdapter] = createSignal<string>("echo");
  const [selectedModel, setSelectedModel] = createSignal<string>("");
  const [selectedRole, setSelectedRole] = createSignal<string>("executor");
  const [flowSpec, setFlowSpec] = createSignal<string>("");
  const [submitting, setSubmitting] = createSignal<boolean>(false);
  const [errorPayload, setErrorPayload] = createSignal<StartRunResponse | null>(null);

  // Models are keyed by adapter; refetch when the dropdown changes.
  const [models] = createResource<readonly ModelInfo[], string>(
    () => selectedAdapter(),
    (vendor) => (vendor ? fetchAdapterModels(vendor) : Promise.resolve([] as readonly ModelInfo[])),
  );

  // Preselect the marked-default model whenever the models list refreshes.
  createEffect(() => {
    const list = models();
    if (!list || list.length === 0) {
      setSelectedModel("");
      return;
    }
    const marked = list.find((m) => m.default === true);
    setSelectedModel(marked?.id ?? list[0]?.id ?? "");
  });

  const resumeNote = () => {
    const id = searchParams.resume;
    return typeof id === "string" && id.length > 0 ? id : null;
  };

  const onSubmit = async (ev: Event) => {
    ev.preventDefault();
    if (submitting()) return;
    setSubmitting(true);
    setErrorPayload(null);
    try {
      const base = {
        task: task(),
        adapter: selectedAdapter(),
        role: selectedRole(),
      };
      const payload: Parameters<typeof startRun>[0] = {
        ...base,
        ...(selectedModel() ? { model: selectedModel() } : {}),
        ...(flowSpec() ? { flow: flowSpec() } : {}),
      };
      const result = await startRun(payload);
      if (result.ok) {
        navigate(result.url);
      } else {
        setErrorPayload(result);
      }
    } catch (err) {
      setErrorPayload({
        ok: false,
        code: "network",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section class="new-run">
      <header class="new-run__header">
        <h1>Start a new run</h1>
        <Show when={resumeNote()}>
          <p class="new-run__resume-note">
            Resuming from cancelled run: <code class="mono">{resumeNote()}</code>
          </p>
        </Show>
      </header>

      <form class="new-run__form" onSubmit={onSubmit}>
        <label class="new-run__field">
          <span class="new-run__label">Task</span>
          <textarea
            class="new-run__textarea"
            value={task()}
            onInput={(e) => setTask(e.currentTarget.value)}
            placeholder="Describe what the swarm should do…"
            rows={6}
            required
          />
        </label>

        <label class="new-run__field">
          <span class="new-run__label">Adapter</span>
          <select
            class="new-run__select"
            value={selectedAdapter()}
            onChange={(e) => setSelectedAdapter(e.currentTarget.value)}
          >
            <option value="echo">echo (scripted, no vendor CLI)</option>
            <For each={adapters() ?? []}>
              {(a) => (
                <option value={a.vendor} disabled={!a.ok}>
                  {a.vendor}
                  {a.ok ? "" : ` (unavailable: ${truncate(a.error ?? "not installed", 80)})`}
                </option>
              )}
            </For>
          </select>
          <Show when={!adapters.loading && (adapters() ?? []).length === 0}>
            <p class="new-run__hint muted">
              No vendor CLIs detected. Echo is always available for a smoke run.
            </p>
          </Show>
        </label>

        <label class="new-run__field">
          <span class="new-run__label">Model</span>
          <select
            class="new-run__select"
            value={selectedModel()}
            onChange={(e) => setSelectedModel(e.currentTarget.value)}
          >
            <For each={models() ?? []}>
              {(m) => (
                <option value={m.id}>
                  {m.label}
                  {m.default ? " (default)" : ""}
                </option>
              )}
            </For>
            <Show when={(models() ?? []).length === 0}>
              <option value="">(no models known)</option>
            </Show>
          </select>
        </label>

        <label class="new-run__field">
          <span class="new-run__label">Role</span>
          <select
            class="new-run__select"
            value={selectedRole()}
            onChange={(e) => setSelectedRole(e.currentTarget.value)}
          >
            <For each={ROLES}>{(r) => <option value={r}>{r}</option>}</For>
          </select>
        </label>

        <label class="new-run__field">
          <span class="new-run__label">Flow (optional)</span>
          <input
            class="new-run__input"
            type="text"
            value={flowSpec()}
            onInput={(e) => setFlowSpec(e.currentTarget.value)}
            placeholder="e.g. @shamu/flows-plan-execute-review (leave blank for single adapter)"
          />
        </label>

        <div class="new-run__actions">
          <button type="submit" class="btn btn--primary" disabled={submitting() || !task()}>
            {submitting() ? "starting…" : "Start run"}
          </button>
        </div>

        <Show when={errorPayload()}>{(payload) => <SubmitError payload={payload()} />}</Show>
      </form>
    </section>
  );
}

function SubmitError(props: { payload: StartRunResponse }) {
  const p = props.payload;
  if (p.ok) return null;
  return (
    <div class="new-run__error" role="alert">
      <h2>Could not start run</h2>
      <p class="mono">{p.message}</p>
      <Show when={p.code === "vendor-cli-not-found" && "checked" in p && p.checked.length > 0}>
        <details>
          <summary>Checked locations</summary>
          <ul class="new-run__checked-list">
            <For each={"checked" in p ? p.checked : []}>
              {(path) => <li class="mono">{path}</li>}
            </For>
          </ul>
        </details>
      </Show>
    </div>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
