// Runs the shared adapter contract suite against a ClaudeAdapter that's
// driven by a scripted SDK double. Live-vendor tests are gated separately
// (see test/live/*). This run MUST be fast + hermetic — no subprocesses.
//
// HANDOFF followup #5: `STRESS_ITERATIONS` env override is honored by the
// base `stressNoLeaksScenario`; the contract suite picks it up
// automatically. Setting `STRESS_ITERATIONS=100` makes the stress row
// run 100 cycles against this scripted driver.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHandle } from "@shamu/adapters-base";
import type { AdapterUnderTest } from "@shamu/adapters-base/contract";
import { runAdapterContractSuite } from "@shamu/adapters-base/contract";
import { afterAll, beforeAll } from "vitest";
import {
  CLAUDE_CAPABILITIES,
  ClaudeAdapter,
  type ClaudeDriver,
  type ClaudeDriverFactory,
  type ClaudeRaw,
} from "../src/index.ts";

let rootDir: string;

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), "shamu-claude-contract-"));
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

// ---- scripted driver double ----------------------------------------------
//
// The double inspects the prompt text and replays a scripted sequence of
// Claude raw messages so the handle's projector sees realistic input.
// Keeps the contract suite free of any real SDK spawn.

const PLANTED_SECRET = "sk-ant-FAKE-FIXTURE-aAbBcCdDeEfFgGhHiI123456";

function scriptForPrompt(prompt: string): ClaudeRaw[] {
  const base: ClaudeRaw[] = [{ type: "system", subtype: "init", session_id: "sess-ctr" }];

  // G4 / G5 probes (Phase 7.G fail-loud migration). Claude's real gate
  // lives in `canUseTool` inside the SDK; the scripted driver has no
  // canUseTool callback to trigger. Instead we emit the tool_use the
  // adapter WOULD have rejected, then synthesize a non-success `result`
  // whose `subtype` the projector turns into an `error` event — same
  // effective shape the real canUseTool path produces after a deny.
  if (/CONTRACT_PROBE_PATH_SCOPE_ESCAPE/.test(prompt)) {
    base.push({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolcall_probe_path",
            name: "Write",
            input: {
              file_path: "/etc/shamu_contract_probe.txt",
              content: "probe",
            },
          },
        ],
      },
    } as ClaudeRaw);
    base.push({
      type: "result",
      subtype: "path_scope_violation",
      duration_ms: 1,
      total_cost_usd: 0.0001,
      usage: { input_tokens: 1, output_tokens: 0 },
    } as ClaudeRaw);
    return base;
  }

  if (/CONTRACT_PROBE_SHELL_SUBSTITUTION/.test(prompt)) {
    base.push({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolcall_probe_shell",
            name: "Bash",
            input: { command: "echo $(whoami)" },
          },
        ],
      },
    } as ClaudeRaw);
    base.push({
      type: "result",
      subtype: "shell_gate_command_substitution",
      duration_ms: 1,
      total_cost_usd: 0.0001,
      usage: { input_tokens: 1, output_tokens: 0 },
    } as ClaudeRaw);
    return base;
  }

  // Long-running "Count slowly" turn: emit an assistant_delta, then park so
  // the interrupt scenario can fire. The driver's `nextStep` waits for
  // interrupt before emitting a terminal result.
  if (/Count slowly/i.test(prompt)) {
    base.push({
      type: "assistant",
      message: {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "1" }],
      },
    } as ClaudeRaw);
    return base;
  }

  if (/definitely-does-not-exist/i.test(prompt)) {
    // error-surfaces scenario — synthesize a fatal result subtype.
    base.push({
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 1,
      total_cost_usd: 0.0001,
      usage: { input_tokens: 1, output_tokens: 0 },
    } as ClaudeRaw);
    return base;
  }

  // Plant a scripted assistant + optional tool-call/result, then a success
  // result message. Include planted secret redaction in the assistant text
  // when the prompt asks us to echo it.
  const wantsSecretEcho = prompt.includes(PLANTED_SECRET);
  const assistantText = wantsSecretEcho
    ? `Echoing back: ${PLANTED_SECRET}`
    : prompt.length > 0
      ? prompt.slice(0, 24)
      : "hello";

  base.push({
    type: "assistant",
    message: {
      stop_reason: "end_turn",
      content: [{ type: "text", text: assistantText }],
    },
  } as ClaudeRaw);

  if (/Read .+README\.md/i.test(prompt)) {
    base.push({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolcall_read",
            name: "Read",
            input: { file_path: "README.md" },
          },
        ],
      },
    } as ClaudeRaw);
    base.push({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolcall_read",
            content: "Contents of README.md (scripted).",
          },
        ],
      },
    } as ClaudeRaw);
  }

  if (/Create a file/i.test(prompt)) {
    base.push({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolcall_write",
            name: "Write",
            input: { file_path: "note.txt", content: "ok" },
          },
        ],
      },
    } as ClaudeRaw);
    base.push({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolcall_write",
            content: "wrote note.txt (1 line, 0 del)",
          },
        ],
      },
    } as ClaudeRaw);
    // The handle doesn't emit patch_applied on its own (vendor doesn't
    // expose line stats either). We synthesize a cheap patch_applied
    // signal via another assistant message; patch-metadata scenario
    // will still `warn` with no patch_applied but pass.
  }

  base.push({
    type: "result",
    subtype: "success",
    duration_ms: 10,
    total_cost_usd: 0.002,
    usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0 },
  } as ClaudeRaw);
  return base;
}

interface DriverState {
  interrupted: boolean;
  resolveInterrupt: (() => void) | null;
}

function makeScriptedDriver(prompt: string): ClaudeDriver {
  const script = scriptForPrompt(prompt);
  const longRunning = /Count slowly/i.test(prompt);
  const state: DriverState = { interrupted: false, resolveInterrupt: null };

  const makeIterable = (): AsyncIterable<ClaudeRaw> => {
    let index = 0;
    let parked = false;
    const nextStep = async (): Promise<IteratorResult<ClaudeRaw>> => {
      // For the LONG_TURN path: emit session_start + assistant_message,
      // then park waiting for interrupt. On interrupt, emit a terminal
      // result and complete.
      while (longRunning && parked) {
        if (state.interrupted) {
          const terminal: ClaudeRaw = {
            type: "result",
            subtype: "error_during_execution",
            duration_ms: 10,
            total_cost_usd: 0.001,
            usage: { input_tokens: 0, output_tokens: 0 },
          };
          parked = false;
          state.interrupted = false;
          return { value: terminal, done: false };
        }
        await new Promise<void>((resolve) => {
          state.resolveInterrupt = resolve;
        });
        state.resolveInterrupt = null;
      }
      if (index >= script.length) {
        if (longRunning && !parked) {
          parked = true;
          return nextStep();
        }
        return { value: undefined as unknown as ClaudeRaw, done: true };
      }
      const value = script[index] as ClaudeRaw;
      index += 1;
      return { value, done: false };
    };
    return {
      [Symbol.asyncIterator]: () => ({
        next: nextStep,
      }),
    };
  };

  return {
    session: null,
    async startQuery() {
      return {
        [Symbol.asyncIterator]: () => makeIterable()[Symbol.asyncIterator](),
        interrupt: async () => {
          state.interrupted = true;
          state.resolveInterrupt?.();
        },
        setModel: async () => {},
        setPermissionMode: async () => {},
      };
    },
    async sendOnSession() {
      return makeIterable();
    },
  };
}

const driverFactory: ClaudeDriverFactory = async (ctx) => {
  // Extract the user's prompt text from vendorOpts if provided, else fall
  // back to an empty script. The contract suite sends via handle.send(), so
  // we snoop through a side channel: each turn gets its own startQuery call
  // with the prompt as arg.
  void ctx;
  // We return a driver whose startQuery captures the prompt arg on each
  // invocation so the script is chosen per-turn.
  return {
    session: null,
    async startQuery(prompt) {
      return (await (async () => makeScriptedDriver(prompt))()).startQuery(
        prompt,
        new AbortController().signal,
      );
    },
    async sendOnSession(_s, prompt) {
      return (await (async () => makeScriptedDriver(prompt))()).sendOnSession(_s, prompt);
    },
  };
};

const adapter = new ClaudeAdapter({ driverFactory });

const aut: AdapterUnderTest = {
  adapter,
  vendor: adapter.vendor,
  capabilities: CLAUDE_CAPABILITIES,
  factory: async (ctx) => adapter.spawn(ctx.spawnOpts),
  teardown: async (handle: AgentHandle) => {
    try {
      await handle.shutdown("contract-teardown");
    } catch {
      // shutdown is idempotent; ignore.
    }
  },
  worktreeFor: async (scenarioName) => {
    const dir = join(rootDir, scenarioName.replace(/[^a-z0-9_-]/gi, "_"));
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  // Phase 7.G migration (2026-04-19): claude's fake driver scripts both
  // G4 and G5 probes by emitting the tool_use + a non-success `result`
  // whose subtype the projector turns into an `error` event. The real
  // canUseTool gate is unit-tested in `test/unit/permission-handler.test.ts`;
  // the contract-suite's fail-loud assertion here is driver-side visibility.
  scriptProbe: (probe) => probe === "path-scope" || probe === "shell-gate",
};

runAdapterContractSuite(aut, { timeoutMs: 5_000 });
