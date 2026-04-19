/**
 * Test doubles for the Codex SDK surface.
 *
 * `FakeCodex` + `FakeThread` script a deterministic event stream so the
 * unit + contract suites can exercise the real adapter code paths without
 * spawning the actual `codex` binary. The shapes mirror the minimal
 * interfaces `CodexLike` / `ThreadLike` expose; a compile-time assignment
 * guards that any SDK surface change the adapter relies on is mirrored
 * here.
 */

import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import type { CodexLike, ThreadLike } from "../src/index.ts";

/**
 * Script function for a single turn. Receives the input text the handle
 * forwarded (after redaction) and the abort signal; returns the list of
 * steps to drive in order. A step is either a concrete `ThreadEvent` or
 * the `PARK_UNTIL_ABORT` sentinel (which makes the generator await the
 * abort signal before continuing — useful for the interrupt scenario).
 *
 * If the function yields no events, the turn returns immediately — useful
 * for testing the "empty stream" edge case.
 */
export type TurnScript = (input: string, signal: AbortSignal | undefined) => ThreadEvent[];

/** Default: one canonical "hello" turn. */
export const defaultTurnScript: TurnScript = (_input) => [
  { type: "thread.started", thread_id: "thr_test_0001" },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: {
      id: "item_0",
      type: "agent_message",
      text: "hello",
    },
  },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 0,
      output_tokens: 5,
    },
  },
];

export interface FakeThreadOptions {
  /** Initial thread id (mirrors `resumeThread` wiring). Default null. */
  readonly id?: string | null;
  /**
   * A list of scripts, one per call to `runStreamed`. Index 0 is the
   * first turn, 1 is the second, etc. Over-reading wraps around to the
   * last script in the list so multi-turn contract scenarios work.
   *
   * Each script returns an array of steps — concrete `ThreadEvent`s or
   * the `PARK_UNTIL_ABORT` sentinel — which the fake generator drives
   * in order. A park step makes the generator wait for the abort signal.
   */
  readonly scripts?: ReadonlyArray<
    (input: string, signal: AbortSignal | undefined) => readonly TurnStep[]
  >;
  /**
   * Delay between yielded events in ms. 0 (default) is synchronous —
   * events arrive in a single microtask — which is ideal for fixture
   * tests but lets the contract's `interrupt` scenario fire cleanly too.
   */
  readonly yieldDelayMs?: number;
}

/**
 * A sentinel a script can include in its returned array to indicate "park
 * until the abort signal fires." The fake generator awaits the signal at
 * that point, then exits cleanly. Useful for the interrupt scenario,
 * where the handle needs a live stream to abort against.
 */
export const PARK_UNTIL_ABORT = { __park: true } as const;

/** Extended script type that may include the PARK sentinel. */
export type TurnStep = ThreadEvent | typeof PARK_UNTIL_ABORT;
export type ScriptOrSteps = (input: string, signal: AbortSignal | undefined) => readonly TurnStep[];

export class FakeThread implements ThreadLike {
  private _id: string | null;
  private turnIndex = 0;
  private readonly scripts: readonly ScriptOrSteps[];
  private readonly yieldDelayMs: number;

  /** Records inputs the handle actually forwarded, for assertions. */
  public readonly observedInputs: string[] = [];
  public readonly observedSignals: Array<AbortSignal | undefined> = [];

  constructor(options: FakeThreadOptions = {}) {
    this._id = options.id ?? null;
    this.scripts = (
      options.scripts && options.scripts.length > 0 ? options.scripts : [defaultTurnScript]
    ) as readonly ScriptOrSteps[];
    this.yieldDelayMs = options.yieldDelayMs ?? 0;
  }

  get id(): string | null {
    return this._id;
  }

  async runStreamed(
    input: string,
    turnOptions?: { signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<ThreadEvent> }> {
    this.observedInputs.push(input);
    this.observedSignals.push(turnOptions?.signal);
    const scriptIdx = Math.min(this.turnIndex, this.scripts.length - 1);
    this.turnIndex += 1;
    const script = this.scripts[scriptIdx];
    if (!script) throw new Error("fake-thread: no script configured");
    const rawSteps = script(input, turnOptions?.signal);
    const self = this;
    const yieldDelay = this.yieldDelayMs;
    async function* drive(): AsyncGenerator<ThreadEvent, void, unknown> {
      for (const step of rawSteps) {
        if (yieldDelay > 0) {
          await new Promise((r) => setTimeout(r, yieldDelay));
        }
        if (turnOptions?.signal?.aborted) return;
        if (isParkStep(step)) {
          // Park: resolve only when the abort signal fires. The real SDK
          // would keep the generator pending indefinitely in this slot.
          await waitForAbort(turnOptions?.signal);
          return;
        }
        // Mirror the real SDK: the first `thread.started` rewrites the
        // Thread's id so subsequent reads of `.id` succeed.
        if (step.type === "thread.started") {
          self._id = step.thread_id;
        }
        yield step;
      }
    }
    return { events: drive() };
  }
}

function isParkStep(step: TurnStep): step is typeof PARK_UNTIL_ABORT {
  return typeof step === "object" && step !== null && "__park" in step && step.__park === true;
}

/** Resolve when the signal is aborted. Resolves immediately if no signal. */
function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return Promise.resolve();
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export class FakeCodex implements CodexLike {
  /** Factory for threads started/resumed via this instance. */
  constructor(
    private readonly factory: (kind: "start" | "resume", id: string | null) => ThreadLike,
  ) {}

  startThread(_options?: ThreadOptions): ThreadLike {
    return this.factory("start", null);
  }
  resumeThread(id: string, _options?: ThreadOptions): ThreadLike {
    return this.factory("resume", id);
  }
}

/**
 * Produce a "hello world" canonical stream the contract suite's
 * spawn-basic / multi-turn / set-model / usage-and-cost / shutdown
 * scenarios all accept. The stream carries an agent_message whose text
 * is the input (so the secret-redaction scenario has something to check).
 */
export function echoScript(input: string, _signal: AbortSignal | undefined): ThreadEvent[] {
  return [
    { type: "thread.started", thread_id: "thr_echo_0001" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: {
        id: "item_0",
        type: "agent_message",
        text: `echo: ${input.slice(0, 120)}`,
      },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 8,
        cached_input_tokens: 0,
        output_tokens: 4,
      },
    },
  ];
}

/** Tool-call (command_execution) canonical stream. */
export function readmeToolScript(_input: string): ThreadEvent[] {
  return [
    { type: "thread.started", thread_id: "thr_tool_0001" },
    { type: "turn.started" },
    {
      type: "item.started",
      item: {
        id: "item_0",
        type: "command_execution",
        command: "cat README.md",
        aggregated_output: "",
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "item_0",
        type: "command_execution",
        command: "cat README.md",
        aggregated_output: "# Test Project\n\nHello.",
        exit_code: 0,
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "item_1",
        type: "agent_message",
        text: "Summarized README.",
      },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 10 },
    },
  ];
}

/** Patch-apply (file_change) canonical stream. */
export function patchScript(_input: string): ThreadEvent[] {
  return [
    { type: "thread.started", thread_id: "thr_patch_0001" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: {
        id: "item_0",
        type: "file_change",
        changes: [{ path: "note.txt", kind: "add" }],
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "item_1",
        type: "agent_message",
        text: "Wrote note.txt.",
      },
    },
    {
      type: "turn.completed",
      usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 6 },
    },
  ];
}

/**
 * Path-scope probe script (contract `path-scope-dispatch`, G4). Emits an
 * `item.started` for a `file_change` that targets an absolute path
 * outside the worktree; the CodexHandle's `decidePermission` reception
 * short-circuits the turn with an `error` event and aborts, which is the
 * visible rejection the contract scenario scans for.
 *
 * Phase 7.G migration (2026-04-19): the codex `test/contract.test.ts`
 * declares `scriptProbe('path-scope') === true` so the suite runs
 * fail-loud — a missing G4 gate is a contract violation, not a driver
 * gap. The fake driver's responsibility is just to feed the adapter a
 * rule-breaking `item.started`.
 */
export function pathScopeProbeScript(_input: string): ThreadEvent[] {
  return [
    { type: "thread.started", thread_id: "thr_path_scope_0001" },
    { type: "turn.started" },
    {
      type: "item.started",
      item: {
        id: "item_ps_0",
        type: "file_change",
        changes: [{ path: "/etc/shamu_contract_probe.txt", kind: "add" }],
        // FileChangeItem's `status` is `"completed" | "failed"`; there's
        // no "in_progress" state because the SDK emits `item.started` for
        // file_change only once the patch is done. The probe's G4 gate
        // fires on the path regardless of status — we pick "failed" to
        // reflect that we never expect the write to land.
        status: "failed",
      },
    },
    // No turn.completed: the handle aborts the turn once the gate fires,
    // synthesizing its own `turn_end`. Emitting a terminal here would
    // double-emit.
  ];
}

/**
 * Shell-gate probe script (contract `shell-ast-gate`, G5). Emits an
 * `item.started` for a `command_execution` whose `command` contains
 * `$()` command substitution; the handle's shell-AST gate rejects it
 * before the CLI runs it.
 */
export function shellGateProbeScript(_input: string): ThreadEvent[] {
  return [
    { type: "thread.started", thread_id: "thr_shell_gate_0001" },
    { type: "turn.started" },
    {
      type: "item.started",
      item: {
        id: "item_sg_0",
        type: "command_execution",
        command: "echo $(whoami)",
        aggregated_output: "",
        status: "in_progress",
      },
    },
  ];
}

/** Forced-fail canonical stream (error-surfaces scenario). */
export function failScript(_input: string): ThreadEvent[] {
  return [
    { type: "thread.started", thread_id: "thr_fail_0001" },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: {
        id: "item_0",
        type: "error",
        message: "Requested tool 'definitely-does-not-exist' is unknown.",
      },
    },
    {
      type: "turn.failed",
      error: { message: "tool not found" },
    },
  ];
}

/**
 * Long-running stream used by the interrupt scenario. Emits a reasoning
 * item so the consumer sees at least one event (which is what triggers
 * the scenario's `handle.interrupt()`), then PARKS until the abort
 * signal fires — mirroring a long vendor turn that hasn't hit its
 * `turn.completed` yet.
 */
export function longScript(_input: string, _signal: AbortSignal | undefined): readonly TurnStep[] {
  return [
    { type: "thread.started", thread_id: "thr_long_0001" },
    { type: "turn.started" },
    {
      type: "item.started",
      item: {
        id: "item_0",
        type: "reasoning",
        text: "Counting slowly.",
      },
    },
    PARK_UNTIL_ABORT,
  ];
}
