/**
 * Runs the shared adapter contract suite against a GeminiAdapter driven by
 * a scripted ACP client double. Live-vendor tests are gated separately
 * (see test/live/*.live.test.ts and SHAMU_GEMINI_LIVE=1). This suite MUST
 * be fast + hermetic — no subprocesses.
 *
 * The scripted driver inspects the last `session.prompt` text and replays
 * a tailored ACP event sequence so the handle's projector sees realistic
 * input for each scenario. The driver ALSO scripts the path-scope +
 * shell-gate probes (G4/G5 fail-loud mode) by pushing a synthetic
 * `session/request_permission` back into the handle before returning
 * the prompt result.
 *
 * Mirrors Cursor's contract test with tool-name deltas (`Shell` vs `bash`,
 * `Edit`/`Write`/`ReadFile` capitalization) to exercise Gemini's tool-
 * name dictionary.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHandle } from "@shamu/adapters-base";
import type { AdapterUnderTest } from "@shamu/adapters-base/contract-tests";
import { runAdapterContractSuite } from "@shamu/adapters-base/contract-tests";
import type {
  AcpClient,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpPromptResult,
  AcpProtocolError,
  AcpSessionUpdate,
} from "@shamu/protocol-acp";
import { afterAll, beforeAll } from "vitest";
import { createGeminiAdapter, GEMINI_CAPABILITIES, type GeminiDriver } from "../src/index.ts";

let rootDir: string;

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), "shamu-gemini-contract-"));
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

const PLANTED_SECRET = "sk-ant-FAKE-FIXTURE-aAbBcCdDeEfFgGhHiI123456";

function makeScriptedDriver(): GeminiDriver {
  const sessionUpdateHandlers = new Set<(ev: AcpSessionUpdate) => void>();
  const protocolErrorHandlers = new Set<(err: AcpProtocolError) => void>();
  let permissionHandler: ((req: AcpPermissionRequest) => Promise<AcpPermissionDecision>) | null =
    null;
  let currentSessionId = "sess-gemini-contract-1";
  let counter = 0;
  let pendingCancelResolver: ((r: AcpPromptResult) => void) | null = null;

  const pushSessionUpdate = (ev: AcpSessionUpdate): void => {
    for (const h of sessionUpdateHandlers) h(ev);
  };

  const scriptPrompt = async (prompt: string): Promise<AcpPromptResult> => {
    const sid = currentSessionId;

    if (/definitely-does-not-exist/i.test(prompt)) {
      pushSessionUpdate({
        sessionId: sid,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "no." } },
      } as AcpSessionUpdate);
      return { stopReason: "error", usage: { inputTokens: 0, outputTokens: 0 } };
    }

    if (/Count slowly/i.test(prompt)) {
      pushSessionUpdate({
        sessionId: sid,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "1" } },
      } as AcpSessionUpdate);
      return new Promise<AcpPromptResult>((resolve) => {
        pendingCancelResolver = resolve;
      });
    }

    // Path-scope probe.
    if (/CONTRACT_PROBE_PATH_SCOPE_ESCAPE/.test(prompt)) {
      if (!permissionHandler) {
        return { stopReason: "no_permission_handler" };
      }
      const decision = await permissionHandler({
        sessionId: sid,
        toolCall: {
          toolCallId: `tc-ps-${++counter}`,
          name: "Write",
          input: { file_path: "/etc/shamu_contract_probe.txt", content: "probe" },
        },
        options: [
          { optionId: "opt-allow-once", kind: "allow_once" },
          { optionId: "opt-reject-once", kind: "reject_once" },
        ],
      });
      if (decision.outcome === "selected" && decision.optionId === "opt-reject-once") {
        return { stopReason: "rejected_by_client", usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
    }

    // Shell-gate probe. Exercises Gemini's canonical capitalized "Shell" tool name.
    if (/CONTRACT_PROBE_SHELL_SUBSTITUTION/.test(prompt)) {
      if (!permissionHandler) {
        return { stopReason: "no_permission_handler" };
      }
      const decision = await permissionHandler({
        sessionId: sid,
        toolCall: {
          toolCallId: `tc-sh-${++counter}`,
          name: "Shell",
          input: { command: "echo $(whoami)" },
        },
        options: [
          { optionId: "opt-allow-once", kind: "allow_once" },
          { optionId: "opt-reject-once", kind: "reject_once" },
        ],
      });
      if (decision.outcome === "selected" && decision.optionId === "opt-reject-once") {
        return { stopReason: "rejected_by_client", usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return { stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
    }

    // Default happy path.
    const echoText = prompt.includes(PLANTED_SECRET)
      ? `Echoing back: ${PLANTED_SECRET}`
      : prompt.length > 0
        ? prompt.slice(0, 24)
        : "hello";
    pushSessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: echoText } },
    } as AcpSessionUpdate);

    if (/Read .+README\.md/i.test(prompt)) {
      pushSessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `tc-read-${++counter}`,
          title: "ReadFile",
          kind: "read",
          status: "in_progress",
          rawInput: { path: "README.md" },
        },
      } as AcpSessionUpdate);
      pushSessionUpdate({
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: `tc-read-${counter}`,
          status: "completed",
          content: { type: "text", text: "README contents" },
        },
      } as AcpSessionUpdate);
    }

    return {
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 20 },
    };
  };

  const client: AcpClient = {
    async initialize() {
      return { protocolVersion: 1, agentInfo: { name: "gemini-contract-fake" } };
    },
    async authenticate() {
      return {};
    },
    async newSession() {
      return { sessionId: currentSessionId };
    },
    async loadSession(params) {
      currentSessionId = params.sessionId;
    },
    prompt(params) {
      const text = params.prompt
        .map((p) =>
          typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "",
        )
        .join("");
      return scriptPrompt(text);
    },
    async cancelSession() {
      if (pendingCancelResolver) {
        const resolver = pendingCancelResolver;
        pendingCancelResolver = null;
        resolver({
          stopReason: "cancelled",
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      }
    },
    onSessionUpdate(handler) {
      sessionUpdateHandlers.add(handler);
      return () => sessionUpdateHandlers.delete(handler);
    },
    onPermissionRequest(handler) {
      permissionHandler = handler;
      return () => {
        if (permissionHandler === handler) permissionHandler = null;
      };
    },
    onProtocolError(handler) {
      protocolErrorHandlers.add(handler);
      return () => protocolErrorHandlers.delete(handler);
    },
    onServerRequest() {
      return () => {};
    },
    async sendRequest<T = unknown>(): Promise<T> {
      // unstable_setSessionModel + any other escape-hatch calls are no-ops
      // in the scripted driver — the contract suite's set-model scenario
      // only verifies the adapter-side wire.
      return {} as unknown as T;
    },
    sendNotification() {
      // no-op
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

const adapter = createGeminiAdapter({
  driverFactory: async () => makeScriptedDriver(),
});

const aut: AdapterUnderTest = {
  adapter,
  vendor: adapter.vendor,
  capabilities: GEMINI_CAPABILITIES,
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
  // Gemini scripts both G4 (path-scope) and G5 (shell-gate) probes, so the
  // contract suite runs them fail-loud — same posture as Cursor.
  scriptProbe: (probe) => probe === "path-scope" || probe === "shell-gate",
};

runAdapterContractSuite(aut, { timeoutMs: 5_000 });
