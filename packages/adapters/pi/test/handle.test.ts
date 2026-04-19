/**
 * Unit tests for `PiHandle` + the event projector. Drives synthetic Pi
 * async events through the handle and asserts the normalized `AgentEvent`
 * stream matches the contract.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@shamu/adapters-base";
import { newRunId } from "@shamu/shared/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PiProtocolError } from "../src/errors.ts";
import { createPiAdapter } from "../src/index.ts";
import { makeFakeDriver } from "./harness.ts";

let ROOT_DIR: string;

beforeAll(() => {
  ROOT_DIR = mkdtempSync(join(tmpdir(), "shamu-pi-handle-"));
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
  const drainer = (async () => {
    for await (const ev of events) {
      collected.push(ev);
      if (ev.kind === kind) return;
    }
  })();
  await Promise.race([drainer, timeout]);
  return collected;
}

describe("PiHandle — event projection", () => {
  it("emits session_start at spawn; a typical turn streams assistant_delta + usage + cost + turn_end", async () => {
    const harness = makeFakeDriver();
    const adapter = createPiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: ROOT_DIR });

    void handle.send({ text: "hello" });

    harness.pushEvent({ type: "turn_start" });
    harness.pushEvent({ type: "message_start", message: {} });
    harness.pushEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi " },
    });
    harness.pushEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "there" },
    });
    harness.pushEvent({
      type: "message_update",
      assistantMessageEvent: { type: "done", reason: "stop" },
    });
    harness.pushEvent({ type: "message_end", message: {} });
    harness.pushEvent({ type: "turn_end", message: {}, toolResults: [] });

    const events = await drainUntil(handle.events, "turn_end");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("session_start");
    expect(kinds.filter((k) => k === "assistant_delta").length).toBe(2);
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("cost");
    expect(kinds).toContain("turn_end");
    for (const ev of events) {
      expect(ev.runId).toBe(handle.runId);
    }
    await handle.shutdown("t");
  });

  it("projects tool_call + tool_result from tool_execution_* events with parentEventId linkage", async () => {
    const harness = makeFakeDriver();
    const adapter = createPiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: ROOT_DIR });
    void handle.send({ text: "use a tool" });
    harness.pushEvent({ type: "turn_start" });
    harness.pushEvent({
      type: "tool_execution_start",
      toolCallId: "call_abc",
      toolName: "read",
      args: { path: "README.md" },
    });
    harness.pushEvent({
      type: "tool_execution_end",
      toolCallId: "call_abc",
      toolName: "read",
      result: { content: [{ type: "text", text: "README contents" }] },
      isError: false,
    });
    harness.pushEvent({ type: "turn_end", message: {}, toolResults: [] });

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
      expect(toolResult.summary).toBe("README contents");
      expect(toolCall.tool).toBe("read");
    }
    await handle.shutdown("t");
  });

  it("tool calls embedded in message_update.assistantMessageEvent are NOT projected (single-source-of-truth)", async () => {
    const harness = makeFakeDriver();
    const adapter = createPiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: ROOT_DIR });
    void handle.send({ text: "call a tool" });
    harness.pushEvent({ type: "turn_start" });
    // Simulate Pi emitting toolcall_* in the assistant-message stream alongside
    // the tool_execution_* events. The handle must not emit `tool_call` twice.
    harness.pushEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        partial: { id: "dup_call", name: "read" },
      },
    });
    harness.pushEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        partial: { id: "dup_call", name: "read", input: {} },
      },
    });
    harness.pushEvent({
      type: "tool_execution_start",
      toolCallId: "dup_call",
      toolName: "read",
      args: { path: "x" },
    });
    harness.pushEvent({
      type: "tool_execution_end",
      toolCallId: "dup_call",
      toolName: "read",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    });
    harness.pushEvent({ type: "turn_end", message: {}, toolResults: [] });

    const events = await drainUntil(handle.events, "turn_end");
    const toolCalls = events.filter((e) => e.kind === "tool_call");
    expect(toolCalls.length).toBe(1);
    await handle.shutdown("t");
  });

  it("path-scope violation on a tool_execution_start denies + emits error", async () => {
    const harness = makeFakeDriver();
    const adapter = createPiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: ROOT_DIR });
    void handle.send({ text: "hi" });
    harness.pushEvent({ type: "turn_start" });
    harness.pushEvent({
      type: "tool_execution_start",
      toolCallId: "tc-escape",
      toolName: "write",
      args: { file_path: "/etc/shamu-escape.txt", content: "x" },
    });
    // drain up to the error
    const collected: AgentEvent[] = [];
    const timer = new Promise<void>((r) => setTimeout(r, 200));
    const drainer = (async () => {
      for await (const ev of handle.events) {
        collected.push(ev);
        if (ev.kind === "error") break;
      }
    })();
    await Promise.race([drainer, timer]);
    const err = collected.find((e) => e.kind === "error");
    expect(err?.kind).toBe("error");
    if (err && err.kind === "error") {
      expect(err.errorCode).toBe("path_scope_violation");
      expect(err.fatal).toBe(true);
    }
    // Pi's `abort` command must have been issued.
    const aborts = harness.calls.filter((c) => c.type === "abort");
    expect(aborts.length).toBeGreaterThanOrEqual(1);
    await handle.shutdown("t");
  });

  it("shell-gate violation on a bash tool_execution_start denies + emits error", async () => {
    const harness = makeFakeDriver();
    const adapter = createPiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: ROOT_DIR });
    void handle.send({ text: "hi" });
    harness.pushEvent({ type: "turn_start" });
    harness.pushEvent({
      type: "tool_execution_start",
      toolCallId: "tc-shell",
      toolName: "bash",
      args: { command: "echo $(whoami)" },
    });
    const collected: AgentEvent[] = [];
    const timer = new Promise<void>((r) => setTimeout(r, 200));
    const drainer = (async () => {
      for await (const ev of handle.events) {
        collected.push(ev);
        if (ev.kind === "error") break;
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

  it("protocol errors from the rpc-client surface as non-fatal `error`s", async () => {
    const harness = makeFakeDriver();
    const adapter = createPiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: ROOT_DIR });
    harness.pushProtocolError(new PiProtocolError("bad line", "xxxxx"));
    const collected: AgentEvent[] = [];
    const timer = new Promise<void>((r) => setTimeout(r, 80));
    const drainer = (async () => {
      for await (const ev of handle.events) {
        collected.push(ev);
        if (ev.kind === "error") break;
      }
    })();
    await Promise.race([drainer, timer]);
    const err = collected.find((e) => e.kind === "error");
    expect(err?.kind).toBe("error");
    if (err && err.kind === "error") {
      expect(err.errorCode).toBe("pi_protocol");
      expect(err.fatal).toBe(false);
    }
    await handle.shutdown("t");
  });

  it("unknown Pi event type surfaces as pi_unknown_event (non-fatal)", async () => {
    const harness = makeFakeDriver();
    const adapter = createPiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: ROOT_DIR });
    harness.pushEvent({ type: "brand_new_pi_event", foo: 1 });
    const collected: AgentEvent[] = [];
    const timer = new Promise<void>((r) => setTimeout(r, 80));
    const drainer = (async () => {
      for await (const ev of handle.events) {
        collected.push(ev);
        if (ev.kind === "error") break;
      }
    })();
    await Promise.race([drainer, timer]);
    const err = collected.find((e) => e.kind === "error");
    expect(err?.kind).toBe("error");
    if (err && err.kind === "error") {
      expect(err.errorCode).toBe("pi_unknown_event");
      expect(err.fatal).toBe(false);
    }
    await handle.shutdown("t");
  });

  it("prompt failure emits an error + forces turn_end", async () => {
    const harness = makeFakeDriver({
      sendCommand: async (type) => {
        if (type === "prompt") throw new Error("pipe closed");
        return undefined;
      },
    });
    const adapter = createPiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: ROOT_DIR });
    await handle.send({ text: "hi" });
    const events = await drainUntil(handle.events, "turn_end");
    const err = events.find((e) => e.kind === "error");
    expect(err?.kind).toBe("error");
    if (err && err.kind === "error") {
      expect(err.errorCode).toBe("pi_prompt_failed");
    }
    await handle.shutdown("t");
  });

  it("interrupt emits interrupt + turn_end + calls abort", async () => {
    const harness = makeFakeDriver();
    const adapter = createPiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: ROOT_DIR });
    await handle.interrupt("user-initiated");
    const collected: AgentEvent[] = [];
    const timer = new Promise<void>((r) => setTimeout(r, 60));
    const drainer = (async () => {
      for await (const ev of handle.events) {
        collected.push(ev);
        if (ev.kind === "turn_end") break;
      }
    })();
    await Promise.race([drainer, timer]);
    expect(collected.some((e) => e.kind === "interrupt")).toBe(true);
    expect(harness.calls.filter((c) => c.type === "abort").length).toBeGreaterThanOrEqual(1);
    await handle.shutdown("t");
  });

  it("setModel dispatches set_model and updates the stamped model id", async () => {
    const harness = makeFakeDriver();
    const adapter = createPiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: ROOT_DIR });
    await handle.setModel("anthropic/claude-sonnet");
    const setModels = harness.calls.filter((c) => c.type === "set_model");
    expect(setModels.length).toBe(1);
    expect(setModels[0]?.params).toEqual({ model: "anthropic/claude-sonnet" });
    await handle.shutdown("t");
  });
});
