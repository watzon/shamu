/**
 * Unit tests for `CursorHandle` + event projection. Drives synthetic ACP
 * session/update notifications + permission requests through the handle
 * and asserts the normalized `AgentEvent` stream matches the contract.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@shamu/adapters-base";
import type { AcpSessionUpdate } from "@shamu/protocol-acp";
import { newRunId } from "@shamu/shared/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCursorAdapter } from "../src/index.ts";
import { makeFakeDriver } from "./harness.ts";

let ROOT_DIR: string;

beforeAll(() => {
  ROOT_DIR = mkdtempSync(join(tmpdir(), "shamu-cursor-handle-"));
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

describe("CursorHandle — event mapping", () => {
  it("emits session_start at spawn and assistant_delta + usage + turn_end per turn", async () => {
    const harness = makeFakeDriver();
    const adapter = createCursorAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });
    const sid = harness.sessionId();

    // Kick off a prompt; before we resolve it, stream an assistant chunk.
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
    const adapter = createCursorAdapter({ driverFactory: async () => harness.driver });
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
        title: "read",
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

  it("path-scope violation in a pending tool call denies + emits error", async () => {
    const harness = makeFakeDriver();
    const adapter = createCursorAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });

    // Drive a permission request for a Write outside the worktree. The
    // handle's pre-dispatch gate must pick `reject_once` and emit an error.
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

    // Drain a few events to confirm the error + permission_request surfaced.
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

  it("shell-gate violation in a pending bash call denies + emits error", async () => {
    const harness = makeFakeDriver();
    const adapter = createCursorAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });

    const decision = await harness.pushPermissionRequest({
      sessionId: harness.sessionId(),
      toolCall: {
        toolCallId: "tc-shell",
        name: "bash",
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
    const adapter = createCursorAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });
    const sid = harness.sessionId();
    harness.pushSessionUpdate({
      sessionId: sid,
      update: { sessionUpdate: "brand_new_unstable_kind", foo: "bar" },
    } as AcpSessionUpdate);
    // Drain the stream briefly.
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
    const adapter = createCursorAdapter({ driverFactory: async () => harness.driver });
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
    const adapter = createCursorAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });
    await handle.send({ text: "hello" });
    const events = await drainUntil(handle.events, "turn_end");
    const err = events.find((e) => e.kind === "error");
    expect(err?.kind).toBe("error");
    if (err && err.kind === "error") {
      expect(err.errorCode).toBe("cursor_prompt_failed");
    }
    await handle.shutdown("t");
  });
});
