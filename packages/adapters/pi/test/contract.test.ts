/**
 * Runs the shared adapter contract suite against a PiAdapter driven by a
 * scripted Pi RPC client double. Live-vendor tests are gated separately
 * (see test/live/*.live.test.ts and SHAMU_PI_LIVE=1). This suite MUST be
 * fast + hermetic — no subprocesses.
 *
 * The scripted driver inspects the last `prompt` command's `message` field
 * and replays a tailored Pi event sequence so the handle's projector sees
 * realistic input for each scenario. It also scripts G4 (path-scope) and
 * G5 (shell-gate) probes by pushing a synthetic `tool_execution_start`
 * event before the `turn_end`, matching the mission's `scriptProbe`
 * declaration.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHandle } from "@shamu/adapters-base";
import type { AdapterUnderTest } from "@shamu/adapters-base/contract-tests";
import { runAdapterContractSuite } from "@shamu/adapters-base/contract-tests";
import { afterAll, beforeAll } from "vitest";
import type { PiDriver } from "../src/driver.ts";
import { createPiAdapter, PI_CAPABILITIES } from "../src/index.ts";
import type { PiAsyncEvent, PiRpcClient } from "../src/rpc-client.ts";

let rootDir: string;

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), "shamu-pi-contract-"));
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

const PLANTED_SECRET = "sk-ant-FAKE-FIXTURE-aAbBcCdDeEfFgGhHiI123456";

/**
 * Per-driver state. Each `spawn()` gets a fresh scripted driver via the
 * adapter factory's `driverFactory: async () => makeScriptedDriver()`.
 */
function makeScriptedDriver(): PiDriver {
  const eventHandlers = new Set<(ev: PiAsyncEvent) => void>();
  let currentSessionId = "/tmp/pi-contract-session-1.jsonl";
  let counter = 0;
  let pendingAbortResolver: (() => void) | null = null;

  const push = (ev: PiAsyncEvent): void => {
    for (const h of eventHandlers) h(ev);
  };

  /**
   * Emit a scripted event sequence for a prompt message. Returns the
   * response-data the prompt command should resolve with.
   */
  const scriptPrompt = async (message: string): Promise<unknown> => {
    // Error-forcing prompt (FAIL_TURN). Emit an `extension_error` BEFORE
    // the terminal `turn_end` so the projector surfaces a non-fatal
    // `error` event inside the drained prefix (the contract suite's
    // error-surfaces scenario stops draining at the first `turn_end`).
    if (/definitely-does-not-exist/i.test(message)) {
      setImmediate(() => {
        push({ type: "turn_start" });
        push({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "no." },
        });
        push({ type: "message_end", message: {} });
        push({
          type: "extension_error",
          extensionPath: "fake-tool",
          event: "tool_call",
          error: "definitely-does-not-exist",
        });
        push({
          type: "turn_end",
          stop_reason: "error",
        });
      });
      return undefined;
    }

    // Long-running prompt (LONG_TURN) — abort ends the turn.
    if (/Count slowly/i.test(message)) {
      setImmediate(() => {
        push({ type: "turn_start" });
        push({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "1" },
        });
      });
      return new Promise<unknown>((resolve) => {
        pendingAbortResolver = () => {
          // Emit a turn_end once the abort command is issued.
          push({ type: "turn_end", stop_reason: "cancelled" });
          resolve(undefined);
        };
      });
    }

    // Path-scope probe.
    if (/CONTRACT_PROBE_PATH_SCOPE_ESCAPE/.test(message)) {
      setImmediate(() => {
        push({ type: "turn_start" });
        push({
          type: "tool_execution_start",
          toolCallId: `tc-ps-${++counter}`,
          toolName: "write",
          args: { file_path: "/etc/shamu_contract_probe.txt", content: "probe" },
        });
        // The handle's gate will emit an error + force turn_end. We also
        // emit a real turn_end in case the gate didn't fire (so the
        // contract suite never hangs).
        setTimeout(() => push({ type: "turn_end", stop_reason: "rejected" }), 20);
      });
      return undefined;
    }

    // Shell-gate probe.
    if (/CONTRACT_PROBE_SHELL_SUBSTITUTION/.test(message)) {
      setImmediate(() => {
        push({ type: "turn_start" });
        push({
          type: "tool_execution_start",
          toolCallId: `tc-sh-${++counter}`,
          toolName: "bash",
          args: { command: "echo $(whoami)" },
        });
        setTimeout(() => push({ type: "turn_end", stop_reason: "rejected" }), 20);
      });
      return undefined;
    }

    // Default happy path. Echo a short chunk + optional tool_call pair.
    const echoText = message.includes(PLANTED_SECRET)
      ? `Echoing back: ${PLANTED_SECRET}`
      : message.length > 0
        ? message.slice(0, 24)
        : "hello";
    setImmediate(() => {
      push({ type: "turn_start" });
      push({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: echoText },
      });

      if (/Read .+README\.md/i.test(message)) {
        const id = `tc-read-${++counter}`;
        push({
          type: "tool_execution_start",
          toolCallId: id,
          toolName: "read",
          args: { path: "README.md" },
        });
        push({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: "read",
          result: { content: [{ type: "text", text: "README contents" }] },
          isError: false,
        });
      }

      if (/note\.txt/i.test(message)) {
        const id = `tc-write-${++counter}`;
        push({
          type: "tool_execution_start",
          toolCallId: id,
          toolName: "write",
          args: { file_path: "note.txt", content: "ok" },
        });
        push({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: "write",
          result: { content: [{ type: "text", text: "wrote 2 bytes" }] },
          isError: false,
        });
      }

      push({ type: "message_end", message: {} });
      push({ type: "turn_end", stop_reason: "end_turn" });
    });
    return undefined;
  };

  const client: PiRpcClient = {
    async sendCommand<T = unknown>(
      type: string,
      params: Readonly<Record<string, unknown>> = {},
    ): Promise<T> {
      if (type === "prompt") {
        const msg = typeof params.message === "string" ? (params.message as string) : "";
        const data = await scriptPrompt(msg);
        return data as T;
      }
      if (type === "new_session") {
        return { sessionId: currentSessionId } as unknown as T;
      }
      if (type === "switch_session") {
        const sp = params.sessionPath;
        if (typeof sp === "string" && sp.length > 0) currentSessionId = sp;
        return undefined as unknown as T;
      }
      if (type === "abort") {
        if (pendingAbortResolver) {
          const resolver = pendingAbortResolver;
          pendingAbortResolver = null;
          resolver();
        }
        return undefined as unknown as T;
      }
      return undefined as unknown as T;
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    onProtocolError() {
      return () => {};
    },
    onReady() {
      return () => {};
    },
    async close() {
      // no-op
    },
  };

  return {
    client,
    async close() {
      // no-op
    },
  };
}

const adapter = createPiAdapter({
  driverFactory: async () => makeScriptedDriver(),
});

const aut: AdapterUnderTest = {
  adapter,
  vendor: adapter.vendor,
  capabilities: PI_CAPABILITIES,
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
  // Pi scripts both G4 (path-scope) and G5 (shell-gate) probes — fail-loud
  // on missing rejection, matching the Cursor / Gemini posture.
  scriptProbe: (probe) => probe === "path-scope" || probe === "shell-gate",
};

runAdapterContractSuite(aut, { timeoutMs: 5_000 });
