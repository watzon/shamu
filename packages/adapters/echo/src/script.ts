/**
 * `Script` — data-driven event-stream definitions for the echo adapter.
 *
 * Each script is a list of `Step`s; `EchoHandle` walks it, feeds each step
 * through `CorrelationState` to produce a real `AgentEvent`, and pushes the
 * event onto the handle's queue. Steps are deterministic — no wall-clock
 * reads, no random numbers — so tests can reason about the stream shape
 * without time-based flake.
 *
 * The `chooseScript(prompt)` helper is the only place where prompt-matching
 * lives. It handles the contract-suite fixture turns (hello, follow-up,
 * tool-call, patch, long/interrupt, fail, secret) and defaults to a
 * generic "one turn, one assistant message" script for unknown prompts.
 */

/** One step in a scripted turn. The handle consumes these in order. */
export type Step =
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "assistant_delta"; readonly text: string }
  | { readonly kind: "assistant_message"; readonly text: string; readonly stopReason: string }
  | {
      readonly kind: "tool_call";
      readonly tool: string;
      readonly args: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "tool_result";
      readonly ok: boolean;
      readonly summaryText: string;
      readonly bytes: number;
    }
  | {
      readonly kind: "patch_applied";
      readonly files: readonly string[];
      readonly add: number;
      readonly del: number;
    }
  | {
      readonly kind: "permission_request";
      readonly decision: "pending" | "allow" | "deny" | "ask";
    }
  | {
      readonly kind: "usage";
      readonly input: number;
      readonly output: number;
      readonly cacheHits: number;
      readonly cacheMisses: number;
    }
  | {
      readonly kind: "cost";
      readonly usd: number | null;
      readonly confidence: "exact" | "estimate" | "unknown";
    }
  | {
      readonly kind: "error";
      readonly fatal: boolean;
      readonly errorCode: string;
      readonly message: string;
      readonly retriable: boolean;
    }
  | { readonly kind: "park" }
  | { readonly kind: "turn_end"; readonly stopReason: string; readonly durationMs: number };

/**
 * A script is a sequence of steps for one turn. The handle wraps each step
 * with an `EventEnvelope` from its `CorrelationState`, and pairs tool_calls
 * with tool_results using the id allocated at emit time.
 */
export interface Script {
  readonly id: string;
  readonly steps: readonly Step[];
}

/**
 * The planted-secret literal used across the contract suite's fixtures
 * (re-exported from `@shamu/adapters-base/contract`). The echo adapter
 * deliberately embeds this string in one tool_call arg and one tool_result
 * summary so the central redactor has something to scrub. The pattern
 * matches the `anthropic_key` regex in `@shamu/shared/redactor` — prefix
 * `sk-ant-` + 20+ chars of `[A-Za-z0-9_-]` — so the masked form round-trips
 * as `<REDACTED:anthropic_key>`.
 */
export const PLANTED_SECRET_TOKEN = "sk-ant-FAKE-FIXTURE-aAbBcCdDeEfFgGhHiI123456";

const DEFAULT_USAGE: Extract<Step, { kind: "usage" }> = {
  kind: "usage",
  input: 12,
  output: 18,
  cacheHits: 0,
  cacheMisses: 1,
};

/**
 * `confidence` on the cost step is "estimate" because the echo adapter's
 * capability manifest declares `costReporting: "computed"`. The contract
 * suite's `usage-and-cost` scenario asserts this mapping.
 */
const DEFAULT_COST: Extract<Step, { kind: "cost" }> = {
  kind: "cost",
  usd: 0.0015,
  confidence: "estimate",
};

/** Default hello-world script used when no prompt is supplied. */
const HELLO_SCRIPT: Script = {
  id: "hello",
  steps: [
    { kind: "reasoning", text: "User wants a greeting. Plan: emit a one-line hello." },
    { kind: "assistant_delta", text: "hello" },
    { kind: "assistant_message", text: "hello, world", stopReason: "end_turn" },
    DEFAULT_USAGE,
    DEFAULT_COST,
    { kind: "turn_end", stopReason: "end_turn", durationMs: 1 },
  ],
};

/** Script for the standard `HELLO_TURN` contract fixture. */
const HELLO_FIXTURE_SCRIPT: Script = {
  id: "hello-fixture",
  steps: [
    { kind: "assistant_delta", text: "hello" },
    { kind: "assistant_message", text: "hello", stopReason: "end_turn" },
    DEFAULT_USAGE,
    DEFAULT_COST,
    { kind: "turn_end", stopReason: "end_turn", durationMs: 1 },
  ],
};

/** Follow-up turn (contract multi-turn scenario). */
const GOODBYE_SCRIPT: Script = {
  id: "goodbye",
  steps: [
    { kind: "assistant_delta", text: "goodbye" },
    { kind: "assistant_message", text: "goodbye", stopReason: "end_turn" },
    DEFAULT_USAGE,
    DEFAULT_COST,
    { kind: "turn_end", stopReason: "end_turn", durationMs: 1 },
  ],
};

/**
 * Tool-call script (contract `tool-call-visibility` scenario and the default
 * "task" script). Steps reference `tool_call` and `tool_result`; the handle
 * links them via the freshly minted `toolCallId`.
 *
 * The args include a planted secret inside a `note` field so the central
 * redactor has something to scrub. The redactor runs on every emitted event,
 * so the on-stream version is masked even though this payload contains the
 * literal fake key.
 */
const TOOL_CALL_SCRIPT: Script = {
  id: "tool-call",
  steps: [
    { kind: "reasoning", text: "I should read README.md to answer the user's question." },
    {
      kind: "tool_call",
      tool: "Read",
      args: {
        file_path: "README.md",
        note: `debug token: ${PLANTED_SECRET_TOKEN}`,
      },
    },
    {
      kind: "tool_result",
      ok: true,
      summaryText: `README contains project title + description. token: ${PLANTED_SECRET_TOKEN}`,
      bytes: 128,
    },
    { kind: "assistant_delta", text: "summarized" },
    {
      kind: "assistant_message",
      text: "The README describes a small example project.",
      stopReason: "end_turn",
    },
    DEFAULT_USAGE,
    DEFAULT_COST,
    { kind: "turn_end", stopReason: "end_turn", durationMs: 2 },
  ],
};

/** Patch-apply script (contract `patch-metadata` scenario). */
const PATCH_SCRIPT: Script = {
  id: "patch",
  steps: [
    {
      kind: "tool_call",
      tool: "Write",
      args: { file_path: "note.txt", content: "ok" },
    },
    {
      kind: "tool_result",
      ok: true,
      summaryText: "wrote 2 bytes to note.txt",
      bytes: 2,
    },
    { kind: "patch_applied", files: ["note.txt"], add: 1, del: 0 },
    {
      kind: "assistant_message",
      text: "Created note.txt with the word 'ok'.",
      stopReason: "end_turn",
    },
    DEFAULT_USAGE,
    DEFAULT_COST,
    { kind: "turn_end", stopReason: "end_turn", durationMs: 2 },
  ],
};

/**
 * Long / parkable turn — the contract `interrupt` scenario sends this and
 * relies on `handle.interrupt()` to break out. We emit one delta, then park
 * (`park` step blocks the walker); the handle's `interrupt()` clears the
 * park and emits the `interrupt` + `turn_end` tail.
 */
const LONG_SCRIPT: Script = {
  id: "long",
  steps: [{ kind: "assistant_delta", text: "1" }, { kind: "park" }],
};

/**
 * Forced-fail script (contract `error-surfaces`). Emits a fatal error and
 * ends the turn with stopReason=error.
 */
const FAIL_SCRIPT: Script = {
  id: "fail",
  steps: [
    {
      kind: "error",
      fatal: true,
      errorCode: "tool_not_found",
      message: "Requested tool 'definitely-does-not-exist' is unknown.",
      retriable: false,
    },
    DEFAULT_USAGE,
    DEFAULT_COST,
    { kind: "turn_end", stopReason: "error", durationMs: 1 },
  ],
};

/**
 * Path-scope probe script (contract `path-scope-dispatch`, G4).
 *
 * Echo has no real permission handler — it's a stub — but the contract
 * suite's fail-loud mode for `scriptProbe('path-scope') === true` only
 * asks for a visible rejection signal. We emit a synthetic
 * `permission_request` with `decision: "deny"` paired with the offending
 * `tool_call` / `tool_result` so the scenario's event scanner (and any
 * reviewer eyeballing the stream) can correlate the denial to a concrete
 * out-of-worktree write attempt. This keeps echo participating in the
 * G4 contract row without pretending the stub enforces anything.
 */
const PATH_SCOPE_SCRIPT: Script = {
  id: "path-scope-probe",
  steps: [
    {
      kind: "tool_call",
      tool: "Write",
      args: { file_path: "/etc/shamu_contract_probe.txt", content: "probe" },
    },
    { kind: "permission_request", decision: "deny" },
    {
      kind: "tool_result",
      ok: false,
      summaryText: "path_scope_violation: write to /etc/shamu_contract_probe.txt rejected",
      bytes: 0,
    },
    {
      kind: "error",
      fatal: false,
      errorCode: "path_scope_violation",
      message: "write target /etc/shamu_contract_probe.txt is outside the worktree",
      retriable: false,
    },
    DEFAULT_USAGE,
    DEFAULT_COST,
    { kind: "turn_end", stopReason: "rejected_by_client", durationMs: 1 },
  ],
};

/**
 * Shell-gate probe script (contract `shell-ast-gate`, G5). Same shape as
 * the path-scope script: a tool_call, a denying permission_request, and
 * an error event whose code satisfies the scenario's scanner.
 */
const SHELL_GATE_SCRIPT: Script = {
  id: "shell-gate-probe",
  steps: [
    {
      kind: "tool_call",
      tool: "Bash",
      args: { command: "echo $(whoami)" },
    },
    { kind: "permission_request", decision: "deny" },
    {
      kind: "tool_result",
      ok: false,
      summaryText: "shell_gate: command-substitution rejected",
      bytes: 0,
    },
    {
      kind: "error",
      fatal: false,
      errorCode: "shell_gate_command_substitution",
      message: "bash command rejected: $() command substitution is disallowed",
      retriable: false,
    },
    DEFAULT_USAGE,
    DEFAULT_COST,
    { kind: "turn_end", stopReason: "rejected_by_client", durationMs: 1 },
  ],
};

/**
 * Secret-echo script (contract `secret-redaction`). The user prompt embeds
 * the planted secret; we echo it back inside both a `tool_call` argument
 * and the `tool_result` summary so redaction has to scrub three sites:
 * delta, assistant_message, and tool args/result.
 */
const SECRET_SCRIPT: Script = {
  id: "secret",
  steps: [
    {
      kind: "tool_call",
      tool: "Read",
      args: {
        file_path: "/etc/tokens",
        planted: PLANTED_SECRET_TOKEN,
      },
    },
    {
      kind: "tool_result",
      ok: true,
      summaryText: `contents: ${PLANTED_SECRET_TOKEN}`,
      bytes: 48,
    },
    {
      kind: "assistant_delta",
      text: `here is the token: ${PLANTED_SECRET_TOKEN}`,
    },
    {
      kind: "assistant_message",
      text: `Token retrieved; it begins with ${PLANTED_SECRET_TOKEN}`,
      stopReason: "end_turn",
    },
    DEFAULT_USAGE,
    DEFAULT_COST,
    { kind: "turn_end", stopReason: "end_turn", durationMs: 1 },
  ],
};

/** Minimal echo of the raw prompt, for any prompt that doesn't match a fixture. */
function echoScript(text: string): Script {
  const truncated = text.slice(0, 120);
  return {
    id: "echo",
    steps: [
      { kind: "assistant_delta", text: truncated.slice(0, 32) || "(empty)" },
      {
        kind: "assistant_message",
        text: truncated.length > 0 ? truncated : "(empty prompt)",
        stopReason: "end_turn",
      },
      DEFAULT_USAGE,
      DEFAULT_COST,
      { kind: "turn_end", stopReason: "end_turn", durationMs: 1 },
    ],
  };
}

/**
 * Choose the right script based on the user's prompt text.
 *
 * Order matters: more specific matches first. The contract suite's
 * fixtures are all lower-case verbs ("say", "read", "count") so we rely on
 * distinguishing keywords to avoid cross-matching.
 */
export function chooseScript(prompt: string | null | undefined): Script {
  if (prompt === undefined || prompt === null) return HELLO_SCRIPT;
  const text = prompt.trim();
  if (text.length === 0) return HELLO_SCRIPT;
  const lower = text.toLowerCase();

  // `FAIL_TURN`
  if (lower.includes("definitely-does-not-exist")) return FAIL_SCRIPT;
  // G4 probe — `PATH_SCOPE_ESCAPE_TURN`.
  if (text.includes("CONTRACT_PROBE_PATH_SCOPE_ESCAPE")) return PATH_SCOPE_SCRIPT;
  // G5 probe — `SHELL_SUBSTITUTION_TURN`.
  if (text.includes("CONTRACT_PROBE_SHELL_SUBSTITUTION")) return SHELL_GATE_SCRIPT;
  // `SECRET_TURN` — carries the planted secret substring.
  if (text.includes(PLANTED_SECRET_TOKEN)) return SECRET_SCRIPT;
  // `LONG_TURN` — "Count slowly from 1 to 100".
  if (lower.includes("count slowly")) return LONG_SCRIPT;
  // `PATCH_TURN` — "Create a file named ..."
  if (lower.includes("create a file")) return PATCH_SCRIPT;
  // `TOOL_CALL_TURN` — "Read the file README.md ..."
  if (/read\s+.+readme\.md/i.test(text)) return TOOL_CALL_SCRIPT;
  // `FOLLOWUP_TURN` — "Now say 'goodbye'."
  if (lower.includes("goodbye")) return GOODBYE_SCRIPT;
  // `HELLO_TURN` — "Say the word 'hello' and then end your turn."
  if (lower.includes("say the word 'hello'") || lower.includes("say 'hello'")) {
    return HELLO_FIXTURE_SCRIPT;
  }
  return echoScript(text);
}

/** Exposed for tests that want to assert script selection deterministically. */
export const SCRIPTS = Object.freeze({
  hello: HELLO_SCRIPT,
  helloFixture: HELLO_FIXTURE_SCRIPT,
  goodbye: GOODBYE_SCRIPT,
  toolCall: TOOL_CALL_SCRIPT,
  patch: PATCH_SCRIPT,
  long: LONG_SCRIPT,
  fail: FAIL_SCRIPT,
  secret: SECRET_SCRIPT,
  pathScope: PATH_SCOPE_SCRIPT,
  shellGate: SHELL_GATE_SCRIPT,
});
