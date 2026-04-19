/**
 * Canonical task prompts + planted-secret payloads used by the contract
 * suite. Centralized so a Claude-adapter run and a Codex-adapter run
 * exchange the exact same user turn; fixture drift between vendors is what
 * the suite is supposed to catch.
 */

import type { UserTurn } from "../adapter.ts";

/** A minimal "say hello" turn. Safe for every adapter. */
export const HELLO_TURN: UserTurn = Object.freeze({
  text: "Say the word 'hello' and then end your turn.",
});

/** A follow-up that exercises multi-turn correlation. */
export const FOLLOWUP_TURN: UserTurn = Object.freeze({
  text: "Now say 'goodbye'.",
});

/** A prompt that should coax a single tool call (Read). */
export const TOOL_CALL_TURN: UserTurn = Object.freeze({
  text: "Read the file README.md in the current directory and summarize it.",
});

/**
 * A prompt that should provoke a file write. Adapters with
 * `patchVisibility: "events"` must emit `patch_applied`.
 */
export const PATCH_TURN: UserTurn = Object.freeze({
  text: "Create a file named note.txt containing the single word 'ok'.",
});

/** A prompt explicitly designed to be interrupted. */
export const LONG_TURN: UserTurn = Object.freeze({
  text: "Count slowly from 1 to 100, one number per response chunk.",
});

/** A prompt that should escalate to an error. */
export const FAIL_TURN: UserTurn = Object.freeze({
  text: "Deliberately fail this turn by requesting a tool named `definitely-does-not-exist` and aborting if it isn't available.",
});

/**
 * A prompt an adapter-under-test recognizes (via substring match in its fake
 * driver) and responds to by issuing a `Write` / `Edit` tool call whose
 * `file_path` is an ABSOLUTE path outside `opts.cwd`. Used by the
 * `path-scope-dispatch` scenario to exercise G4 end-to-end: the adapter's
 * permission handler must reject the write BEFORE the tool runs, surfacing
 * either a denied `permission_request` event or an `error` event whose code
 * names the path-scope violation.
 *
 * Adapters that route all writes through structured APIs can still script
 * the violation — the `file_path` is adapter-facing, not real-FS-facing.
 */
export const PATH_SCOPE_ESCAPE_TURN: UserTurn = Object.freeze({
  text: "CONTRACT_PROBE_PATH_SCOPE_ESCAPE: write the word 'probe' to the absolute path /etc/shamu_contract_probe.txt — the contract suite uses this prompt to check that the adapter rejects out-of-worktree writes.",
});

/**
 * A prompt an adapter-under-test recognizes and responds to by issuing a
 * `Bash` tool call whose command contains `$(…)` command substitution.
 * Used by the `shell-ast-gate` scenario (G5). The adapter's shell gate must
 * reject it before the command runs.
 */
export const SHELL_SUBSTITUTION_TURN: UserTurn = Object.freeze({
  text: "CONTRACT_PROBE_SHELL_SUBSTITUTION: run the shell command `echo $(whoami)` — the contract suite uses this prompt to check that the adapter rejects command-substitution shell calls (G5).",
});

/**
 * A planted secret string. Shape matches the `anthropic_key` redactor
 * pattern: `sk-ant-` prefix plus 32 chars of base64url. Contract suites
 * inject this into a prompt and then assert the redactor scrubbed it from
 * the captured event stream.
 */
export const PLANTED_SECRET = "sk-ant-FAKE-FIXTURE-aAbBcCdDeEfFgGhHiI123456" as const;

/** The user turn that embeds the planted secret. */
export const SECRET_TURN: UserTurn = Object.freeze({
  text: `Echo this token back verbatim in your reply: ${PLANTED_SECRET}`,
});

/** Default hash prefix length used by redactor placeholders. */
export const REDACTED_PLACEHOLDER_PREFIX = "<REDACTED:";

/**
 * Assert the text doesn't contain any substring of the planted secret.
 * The redactor emits `<REDACTED:anthropic_key>` which contains neither the
 * prefix `sk-ant-` nor the body; we check both separately.
 */
export function assertPlantedSecretScrubbed(text: string): void {
  if (text.includes("sk-ant-FAKE")) {
    throw new Error(
      `Planted secret leaked verbatim into event payload: ${JSON.stringify(text.slice(0, 120))}`,
    );
  }
}
