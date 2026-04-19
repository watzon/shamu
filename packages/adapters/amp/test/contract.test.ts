/**
 * Runs the shared adapter contract suite against an AmpAdapter driven by a
 * scripted AmpDriver double. Live-vendor tests are gated separately (see
 * test/live/*.live.test.ts and SHAMU_AMP_LIVE=1). This suite MUST be fast +
 * hermetic — no subprocesses.
 *
 * The scripted driver inspects the last stdin line and pushes a tailored
 * JSONL event sequence so the handle's projector sees realistic input for
 * each contract scenario. It also opts in to G4/G5 fail-loud mode by
 * declaring `scriptProbe: (p) => p === "path-scope" || p === "shell-gate"`.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHandle } from "@shamu/adapters-base";
import type { AdapterUnderTest } from "@shamu/adapters-base/contract-tests";
import { runAdapterContractSuite } from "@shamu/adapters-base/contract-tests";
import { afterAll, beforeAll } from "vitest";
import { AMP_CAPABILITIES, type AmpDriver, createAmpAdapter } from "../src/index.ts";

let rootDir: string;

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), "shamu-amp-contract-"));
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

const PLANTED_SECRET = "sk-ant-FAKE-FIXTURE-aAbBcCdDeEfFgGhHiI123456";

/**
 * Per-driver scripted state. Each spawn() gets a fresh driver (the adapter
 * factory wires a new `makeScriptedDriver()` per call), so the mutable
 * state below is per-run.
 */
function makeScriptedDriver(): AmpDriver {
  let counter = 0;
  const sessionId = `amp-contract-${Math.random().toString(36).slice(2)}`;

  const stdoutQueue: string[] = [];
  const stdoutWaiters: Array<(v: IteratorResult<string>) => void> = [];
  let stdoutDone = false;

  const pushLine = (line: string): void => {
    if (stdoutDone) return;
    const w = stdoutWaiters.shift();
    if (w) {
      w({ value: line, done: false });
      return;
    }
    stdoutQueue.push(line);
  };
  const closeStdout = (): void => {
    stdoutDone = true;
    while (stdoutWaiters.length > 0) {
      const w = stdoutWaiters.shift();
      if (w) w({ value: undefined, done: true });
    }
  };

  let stdinClosed = false;

  // Push `{type:"system"}` proactively so session_start lands ASAP after
  // the handle subscribes.
  pushLine(
    JSON.stringify({
      type: "system",
      session_id: sessionId,
      model: "amp-contract-model",
    }),
  );

  /**
   * Scripted line sequence for a given prompt.
   */
  const scriptForPrompt = (prompt: string): string[] => {
    const lines: string[] = [];

    // Error-forcing prompt (FAIL_TURN).
    if (/definitely-does-not-exist/i.test(prompt)) {
      lines.push(
        JSON.stringify({
          type: "result",
          duration_ms: 5,
          is_error: true,
          error: "tool not found",
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      );
      return lines;
    }

    // Long-running prompt (LONG_TURN). Emit a starter delta only — the
    // interrupt scenario calls handle.interrupt() before any terminal
    // event lands, so we must not enqueue a `result` here.
    if (/Count slowly/i.test(prompt)) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { id: `msg-${++counter}`, content: [{ type: "text", text: "1" }] },
        }),
      );
      return lines;
    }

    // Path-scope probe — emit a tool_use block with an absolute path.
    // The handle's G4 gate rejects BEFORE surfacing; the projector still
    // emits the tool_call so the contract-suite sees the vendor's intent,
    // then the handle's error emission + forced turn_end land.
    if (/CONTRACT_PROBE_PATH_SCOPE_ESCAPE/.test(prompt)) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            id: `msg-${++counter}`,
            content: [
              {
                type: "tool_use",
                id: `toolu-ps-${counter}`,
                name: "write",
                input: { file_path: "/etc/shamu_contract_probe.txt", content: "probe" },
              },
            ],
          },
        }),
      );
      // Do NOT emit `{type:"result"}` — the handle's forceTurnEnd path
      // synthesizes a turn_end. Emitting a real result would double-emit.
      return lines;
    }

    // Shell-gate probe — emit a tool_use bash block with command substitution.
    if (/CONTRACT_PROBE_SHELL_SUBSTITUTION/.test(prompt)) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            id: `msg-${++counter}`,
            content: [
              {
                type: "tool_use",
                id: `toolu-sh-${counter}`,
                name: "bash",
                input: { command: "echo $(whoami)" },
              },
            ],
          },
        }),
      );
      return lines;
    }

    // Default happy path. Echo a short chunk + optional tool_use/tool_result.
    const echoText = prompt.includes(PLANTED_SECRET)
      ? `Echoing back: ${PLANTED_SECRET}`
      : prompt.length > 0
        ? prompt.slice(0, 24)
        : "hello";

    const msgId = `msg-${++counter}`;

    // Tool-call-visibility: prompts matching `Read .+README\.md` exercise
    // the tool_call + tool_result round-trip.
    const readsReadme = /Read .+README\.md/i.test(prompt);
    const createsNote = /Create a file named note\.txt/i.test(prompt);

    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          id: msgId,
          content: [{ type: "text", text: echoText }],
        },
      }),
    );

    if (readsReadme) {
      const useId = `toolu-read-${counter}`;
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            id: msgId,
            content: [
              { type: "text", text: echoText },
              {
                type: "tool_use",
                id: useId,
                name: "read",
                input: { file_path: "README.md" },
              },
            ],
          },
        }),
      );
      lines.push(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: useId,
                content: "README contents",
                is_error: false,
              },
            ],
          },
        }),
      );
    }

    if (createsNote) {
      // Surface a tool_use that writes an in-cwd path (allowed) — the
      // contract suite's `patch-metadata` scenario checks that SOME tool
      // call was visible even when the adapter emits no patch_applied.
      const useId = `toolu-write-${counter}`;
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            id: msgId,
            content: [
              {
                type: "tool_use",
                id: useId,
                name: "write",
                input: { file_path: "note.txt", content: "ok" },
              },
            ],
          },
        }),
      );
      lines.push(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: useId,
                content: "wrote note.txt",
                is_error: false,
              },
            ],
          },
        }),
      );
    }

    lines.push(
      JSON.stringify({
        type: "result",
        duration_ms: 10,
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    );
    return lines;
  };

  return {
    async *readLines(): AsyncIterableIterator<string> {
      while (!stdoutDone) {
        const buf = stdoutQueue.shift();
        if (buf !== undefined) {
          yield buf;
          continue;
        }
        const next = await new Promise<IteratorResult<string>>((resolve) => {
          stdoutWaiters.push(resolve);
        });
        if (next.done) return;
        yield next.value;
      }
      while (stdoutQueue.length > 0) {
        const buf = stdoutQueue.shift();
        if (buf !== undefined) yield buf;
      }
    },
    async *readStderr(): AsyncIterableIterator<string> {
      // Silent stderr for contract purposes.
    },
    async writeLine(line: string) {
      if (stdinClosed) throw new Error("scripted driver: stdin closed");
      // Extract the prompt text from the Anthropic-shaped input.
      let text = "";
      try {
        const parsed = JSON.parse(line);
        const content = parsed?.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && block.type === "text") {
              text += typeof block.text === "string" ? block.text : "";
            }
          }
        }
      } catch {
        // ignore; we never send malformed lines from the adapter.
      }
      const scripted = scriptForPrompt(text);
      // Push synchronously so the SSE-like stream drains in order.
      for (const l of scripted) pushLine(l);
    },
    async closeStdin() {
      stdinClosed = true;
    },
    kill() {
      stdinClosed = true;
      closeStdout();
    },
    async close() {
      stdinClosed = true;
      closeStdout();
    },
  };
}

const adapter = createAmpAdapter({
  driverFactory: async () => makeScriptedDriver(),
});

const aut: AdapterUnderTest = {
  adapter,
  vendor: adapter.vendor,
  capabilities: AMP_CAPABILITIES,
  factory: async (ctx) => adapter.spawn(ctx.spawnOpts),
  teardown: async (handle: AgentHandle) => {
    try {
      await handle.shutdown("contract-teardown");
    } catch {
      // idempotent
    }
  },
  worktreeFor: async (scenarioName) => {
    const dir = join(rootDir, scenarioName.replace(/[^a-z0-9_-]/gi, "_"));
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  // Amp's permission handler runs on tool_use messages, so path-scope and
  // shell-AST gates are enforceable. Opt in to fail-loud mode for both.
  scriptProbe: (probe) => probe === "path-scope" || probe === "shell-gate",
};

runAdapterContractSuite(aut, { timeoutMs: 5_000 });
