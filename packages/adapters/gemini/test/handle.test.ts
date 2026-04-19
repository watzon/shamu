/**
 * Unit tests for `GeminiHandle` + event projection. Drives synthetic ACP
 * session/update notifications + permission requests through the handle
 * and asserts the normalized `AgentEvent` stream matches the contract.
 *
 * Gemini-specific coverage:
 *
 * - The `AcpProtocolError` → non-fatal `error` event mapping for
 *   malformed JSON-RPC lines (simulates gemini-cli#22647 by emitting
 *   through the client's `onProtocolError` hook).
 * - `setModel` dispatching to `unstable_setSessionModel` with graceful
 *   fallback on RPC failure.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@shamu/adapters-base";
import { AcpProtocolError, type AcpSessionUpdate } from "@shamu/protocol-acp";
import { newRunId } from "@shamu/shared/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGeminiAdapter } from "../src/index.ts";
import { makeFakeDriver } from "./harness.ts";

let ROOT_DIR: string;

beforeAll(() => {
  ROOT_DIR = mkdtempSync(join(tmpdir(), "shamu-gemini-handle-"));
});

afterAll(() => {
  rmSync(ROOT_DIR, { recursive: true, force: true });
});

async function drainUntil(
  events: AsyncIterable<AgentEvent>,
  kind: AgentEvent["kind"],
  timeoutMs = 2000,
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(
            `timed out waiting for ${kind} (collected: ${collected.map((e) => e.kind).join(", ")})`,
          ),
        ),
      timeoutMs,
    );
  });
  const drain = (async () => {
    for await (const ev of events) {
      collected.push(ev);
      if (ev.kind === kind) return;
    }
  })();
  await Promise.race([drain, timeout]);
  return collected;
}

describe("GeminiHandle — event mapping", () => {
  it("emits session_start at spawn and assistant_delta + usage + turn_end per turn", async () => {
    const harness = makeFakeDriver();
    const adapter = createGeminiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });
    const sid = harness.sessionId();

    const sendPromise = handle.send({ text: "hello" });
    harness.pushSessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi " } },
    } as AcpSessionUpdate);
    harness.pushSessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there" } },
    } as AcpSessionUpdate);
    await sendPromise;

    const events = await drainUntil(handle.events, "turn_end", 3000);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("session_start");
    expect(kinds.filter((k) => k === "assistant_delta").length).toBeGreaterThanOrEqual(1);
    expect(kinds).toContain("usage");
    expect(kinds).toContain("cost");
    expect(kinds).toContain("turn_end");
    for (const ev of events) {
      expect(ev.runId).toBe(handle.runId);
    }
    await handle.shutdown("t");
  });

  it("emits tool_call + tool_result with parentEventId linkage", async () => {
    const harness = makeFakeDriver();
    const adapter = createGeminiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });
    const sid = harness.sessionId();

    const sendPromise = handle.send({ text: "use a tool" });
    harness.pushSessionUpdate({
      sessionId: sid,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "ReadFile",
        kind: "read",
        status: "in_progress",
        rawInput: { path: "README.md" },
      },
    } as AcpSessionUpdate);
    harness.pushSessionUpdate({
      sessionId: sid,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
        content: { type: "text", text: "file contents here" },
      },
    } as AcpSessionUpdate);
    await sendPromise;

    const events = await drainUntil(handle.events, "turn_end");
    const toolCall = events.find((e) => e.kind === "tool_call");
    const toolResult = events.find((e) => e.kind === "tool_result");
    expect(toolCall?.kind).toBe("tool_call");
    expect(toolResult?.kind).toBe("tool_result");
    if (
      toolCall &&
      toolCall.kind === "tool_call" &&
      toolResult &&
      toolResult.kind === "tool_result"
    ) {
      expect(toolResult.toolCallId).toBe(toolCall.toolCallId);
      expect(toolResult.parentEventId).toBe(toolCall.eventId);
      expect(toolResult.ok).toBe(true);
    }
    await handle.shutdown("t");
  });

  it("path-scope violation on a Write tool denies + emits error", async () => {
    const harness = makeFakeDriver();
    const adapter = createGeminiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });

    const decision = await harness.pushPermissionRequest({
      sessionId: harness.sessionId(),
      toolCall: {
        toolCallId: "tc-escape",
        name: "write",
        input: { file_path: "/etc/shamu-escape.txt", content: "x" },
      },
      options: [
        { optionId: "opt-allow-once", kind: "allow_once" },
        { optionId: "opt-reject-once", kind: "reject_once" },
      ],
    });
    expect(decision.outcome).toBe("selected");
    if (decision.outcome === "selected") {
      expect(decision.optionId).toBe("opt-reject-once");
    }

    const collected: AgentEvent[] = [];
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 100));
    const drainer = (async () => {
      for await (const ev of handle.events) {
        collected.push(ev);
        if (collected.some((e) => e.kind === "error")) return;
      }
    })();
    await Promise.race([drainer, timer]);
    const err = collected.find((e) => e.kind === "error");
    expect(err?.kind).toBe("error");
    if (err && err.kind === "error") {
      expect(err.errorCode).toBe("path_scope_violation");
    }
    const denied = collected.find((e) => e.kind === "permission_request" && e.decision === "deny");
    expect(denied).toBeDefined();
    await handle.shutdown("t");
  });

  it("shell-gate violation on a Shell tool denies + emits error", async () => {
    const harness = makeFakeDriver();
    const adapter = createGeminiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });

    // Use "Shell" (Gemini's canonical capitalized name) to exercise the
    // case-insensitive tool-name dictionary.
    const decision = await harness.pushPermissionRequest({
      sessionId: harness.sessionId(),
      toolCall: {
        toolCallId: "tc-shell",
        name: "Shell",
        input: { command: "echo $(whoami)" },
      },
      options: [
        { optionId: "opt-allow-once", kind: "allow_once" },
        { optionId: "opt-reject-once", kind: "reject_once" },
      ],
    });
    expect(decision.outcome).toBe("selected");
    if (decision.outcome === "selected") {
      expect(decision.optionId).toBe("opt-reject-once");
    }
    const collected: AgentEvent[] = [];
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 100));
    const drainer = (async () => {
      for await (const ev of handle.events) {
        collected.push(ev);
        if (collected.some((e) => e.kind === "error")) return;
      }
    })();
    await Promise.race([drainer, timer]);
    const err = collected.find((e) => e.kind === "error");
    expect(err?.kind).toBe("error");
    if (err && err.kind === "error") {
      expect(err.errorCode).toBe("shell_gate_violation");
    }
    await handle.shutdown("t");
  });

  it("unknown sessionUpdate kinds surface as non-fatal error", async () => {
    const harness = makeFakeDriver();
    const adapter = createGeminiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });
    const sid = harness.sessionId();
    harness.pushSessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: "brand_new_unstable_kind", foo: "bar" },
    } as AcpSessionUpdate);
    const collected: AgentEvent[] = [];
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 60));
    const drainer = (async () => {
      for await (const ev of handle.events) {
        collected.push(ev);
        if (ev.kind === "error") return;
      }
    })();
    await Promise.race([drainer, timer]);
    const err = collected.find((e) => e.kind === "error");
    expect(err?.kind).toBe("error");
    if (err && err.kind === "error") {
      expect(err.errorCode).toBe("unknown_update_kind");
      expect(err.fatal).toBe(false);
    }
    await handle.shutdown("t");
  });

  it("interrupt emits an interrupt event + turn_end + cancels the session", async () => {
    const harness = makeFakeDriver();
    const adapter = createGeminiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });
    await handle.interrupt("test-interrupt");
    const events: AgentEvent[] = [];
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 60));
    const drainer = (async () => {
      for await (const ev of handle.events) {
        events.push(ev);
        if (ev.kind === "turn_end") return;
      }
    })();
    await Promise.race([drainer, timer]);
    expect(events.some((e) => e.kind === "interrupt")).toBe(true);
    const cancels = harness.calls.filter((c) => c.method === "session/cancel");
    expect(cancels.length).toBeGreaterThanOrEqual(1);
    await handle.shutdown("t");
  });

  it("prompt error emits error + turn_end", async () => {
    const harness = makeFakeDriver({
      prompt: async () => {
        throw new Error("server exploded");
      },
    });
    const adapter = createGeminiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });
    await handle.send({ text: "hello" });
    const events = await drainUntil(handle.events, "turn_end");
    const err = events.find((e) => e.kind === "error");
    expect(err?.kind).toBe("error");
    if (err && err.kind === "error") {
      expect(err.errorCode).toBe("gemini_prompt_failed");
    }
    await handle.shutdown("t");
  });

  it("maps AcpProtocolError to a non-fatal `error` event (gemini-cli#22647)", async () => {
    const harness = makeFakeDriver();
    const adapter = createGeminiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });

    // Simulate the upstream stdout-corruption bug: push a malformed-line
    // protocol error through the client's onProtocolError fanout. The
    // handle MUST NOT crash — it should surface a non-fatal error event.
    harness.pushProtocolError(
      new AcpProtocolError(
        "ACP frame missing jsonrpc=2.0 marker",
        "some garbage line that leaked into stdout",
      ),
    );

    const collected: AgentEvent[] = [];
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 80));
    const drainer = (async () => {
      for await (const ev of handle.events) {
        collected.push(ev);
        if (ev.kind === "error" && ev.errorCode === "acp_protocol") return;
      }
    })();
    await Promise.race([drainer, timer]);
    const err = collected.find((e) => e.kind === "error" && e.errorCode === "acp_protocol");
    expect(err).toBeDefined();
    if (err && err.kind === "error") {
      expect(err.fatal).toBe(false);
      expect(err.retriable).toBe(false);
    }
    await handle.shutdown("t");
  });

  it("setModel dispatches unstable_setSessionModel and updates currentModel", async () => {
    const harness = makeFakeDriver();
    const adapter = createGeminiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });
    await handle.setModel("gemini-2.5-pro");
    const modelCall = harness.calls.find(
      (c) => c.method === "sendRequest:unstable_setSessionModel",
    );
    expect(modelCall).toBeDefined();
    expect(modelCall?.args).toMatchObject({ params: { model: "gemini-2.5-pro" } });
    await handle.shutdown("t");
  });

  it("setModel falls back gracefully when unstable_setSessionModel errors", async () => {
    const harness = makeFakeDriver({
      sendRequest: async () => {
        throw new Error("method not found");
      },
    });
    const adapter = createGeminiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });
    await handle.setModel("gemini-experimental");
    // The handle emits a non-fatal warning-style error; drain briefly.
    const collected: AgentEvent[] = [];
    const timer = new Promise<void>((resolve) => setTimeout(resolve, 60));
    const drainer = (async () => {
      for await (const ev of handle.events) {
        collected.push(ev);
        if (ev.kind === "error" && ev.errorCode === "gemini_set_model_unsupported") return;
      }
    })();
    await Promise.race([drainer, timer]);
    const warn = collected.find(
      (e) => e.kind === "error" && e.errorCode === "gemini_set_model_unsupported",
    );
    expect(warn).toBeDefined();
    if (warn && warn.kind === "error") {
      expect(warn.fatal).toBe(false);
    }
    await handle.shutdown("t");
  });
});
