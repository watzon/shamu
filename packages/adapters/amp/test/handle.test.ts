/**
 * Unit tests for `AmpHandle` + event projection. Drives synthetic JSONL
 * lines through the projector and asserts the normalized `AgentEvent`
 * stream matches the contract shapes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@shamu/adapters-base";
import { newRunId } from "@shamu/shared/ids";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AmpAdapter, formatUserTurn } from "../src/index.ts";
import { type FakeDriverHarness, makeFakeDriver } from "./harness.ts";

let ROOT_DIR: string;

beforeAll(() => {
  ROOT_DIR = mkdtempSync(join(tmpdir(), "shamu-amp-handle-"));
});

afterAll(() => {
  rmSync(ROOT_DIR, { recursive: true, force: true });
});

async function makeHandleWith(harness: FakeDriverHarness, cwd: string = ROOT_DIR) {
  const adapter = new AmpAdapter({ driverFactory: async () => harness.driver });
  const runId = newRunId();
  const handle = await adapter.spawn({ runId, cwd });
  return { handle, runId };
}

async function collectUntil(
  handle: import("@shamu/adapters-base").AgentHandle,
  predicate: (ev: AgentEvent) => boolean,
  timeoutMs = 2_000,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  const iter = handle.events[Symbol.asyncIterator]();
  while (Date.now() < deadline) {
    const next = await Promise.race([
      iter.next(),
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("collect timeout")), deadline - Date.now()),
      ),
    ]);
    if (next.done) break;
    out.push(next.value);
    if (predicate(next.value)) break;
  }
  return out;
}

describe("formatUserTurn", () => {
  it("produces an Anthropic-shaped JSON line without trailing newline", () => {
    const line = formatUserTurn("hello");
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    });
  });
});

describe("AmpHandle — session_start", () => {
  let harness: FakeDriverHarness;
  beforeEach(() => {
    harness = makeFakeDriver();
  });
  afterEach(async () => {
    harness.closeStdout();
    harness.closeStderr();
  });

  it("emits session_start when the system message arrives", async () => {
    const { handle } = await makeHandleWith(harness);
    harness.pushLine(
      JSON.stringify({
        type: "system",
        session_id: "amp-sess-1",
        model: "amp-default-model",
      }),
    );
    const events = await collectUntil(handle, (e) => e.kind === "session_start");
    const start = events.find((e) => e.kind === "session_start");
    expect(start).toBeDefined();
    if (start && start.kind === "session_start") {
      expect(start.source).toBe("spawn");
    }
    expect(handle.sessionId).toBe("amp-sess-1");
    await handle.shutdown("test");
  });
});

describe("AmpHandle — assistant text + result", () => {
  let harness: FakeDriverHarness;
  beforeEach(() => {
    harness = makeFakeDriver();
  });

  it("emits assistant_delta + usage + cost + turn_end on a complete turn", async () => {
    const { handle } = await makeHandleWith(harness);
    harness.pushLine(
      JSON.stringify({
        type: "system",
        session_id: "amp-sess-1",
        model: "test-model",
      }),
    );
    harness.pushLine(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-1",
          content: [{ type: "text", text: "Hello world" }],
        },
      }),
    );
    harness.pushLine(
      JSON.stringify({
        type: "result",
        duration_ms: 42,
        usage: {
          input_tokens: 5,
          output_tokens: 7,
        },
      }),
    );
    const events = await collectUntil(handle, (e) => e.kind === "turn_end");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("session_start");
    expect(kinds).toContain("assistant_delta");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("cost");
    expect(kinds).toContain("turn_end");

    const usage = events.find((e) => e.kind === "usage");
    if (usage && usage.kind === "usage") {
      expect(usage.tokens.input).toBe(5);
      expect(usage.tokens.output).toBe(7);
      expect(usage.model).toBe("amp-default");
    }
    const cost = events.find((e) => e.kind === "cost");
    if (cost && cost.kind === "cost") {
      expect(cost.usd).toBeNull();
      expect(cost.source).toBe("subscription");
    }
    const turnEnd = events.find((e) => e.kind === "turn_end");
    if (turnEnd && turnEnd.kind === "turn_end") {
      expect(turnEnd.durationMs).toBe(42);
    }
    await handle.shutdown("test");
  });

  it("produces incremental deltas when assistant text grows", async () => {
    const { handle } = await makeHandleWith(harness);
    harness.pushLine(JSON.stringify({ type: "system", session_id: "s", model: "m" }));
    harness.pushLine(
      JSON.stringify({
        type: "assistant",
        message: { id: "msg-1", content: [{ type: "text", text: "Hello" }] },
      }),
    );
    harness.pushLine(
      JSON.stringify({
        type: "assistant",
        message: { id: "msg-1", content: [{ type: "text", text: "Hello world" }] },
      }),
    );
    harness.pushLine(JSON.stringify({ type: "result", duration_ms: 0 }));
    const events = await collectUntil(handle, (e) => e.kind === "turn_end");
    const deltas = events.filter((e) => e.kind === "assistant_delta");
    const combined = deltas.map((e) => (e.kind === "assistant_delta" ? e.text : "")).join("");
    expect(combined).toBe("Hello world");
    await handle.shutdown("test");
  });
});

describe("AmpHandle — tool_use + tool_result correlation", () => {
  it("correlates tool_call and tool_result by tool_use_id", async () => {
    const harness = makeFakeDriver();
    const { handle } = await makeHandleWith(harness);
    harness.pushLine(JSON.stringify({ type: "system", session_id: "s", model: "m" }));
    harness.pushLine(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-tool",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "read",
              input: { file_path: "README.md" },
            },
          ],
        },
      }),
    );
    harness.pushLine(
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "README contents",
              is_error: false,
            },
          ],
        },
      }),
    );
    harness.pushLine(JSON.stringify({ type: "result", duration_ms: 0 }));
    const events = await collectUntil(handle, (e) => e.kind === "turn_end");
    const call = events.find((e) => e.kind === "tool_call");
    const result = events.find((e) => e.kind === "tool_result");
    expect(call).toBeDefined();
    expect(result).toBeDefined();
    if (call && call.kind === "tool_call" && result && result.kind === "tool_result") {
      expect(call.toolCallId).toBe(result.toolCallId);
      expect(result.ok).toBe(true);
      expect(result.summary).toBe("README contents");
      expect(result.parentEventId).toBe(call.eventId);
    }
    await handle.shutdown("test");
  });
});

describe("AmpHandle — reasoning block", () => {
  it("emits a reasoning event for thinking blocks", async () => {
    const harness = makeFakeDriver();
    const { handle } = await makeHandleWith(harness);
    harness.pushLine(JSON.stringify({ type: "system", session_id: "s", model: "m" }));
    harness.pushLine(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "msg-think",
          content: [{ type: "thinking", text: "Let me think about this..." }],
        },
      }),
    );
    harness.pushLine(JSON.stringify({ type: "result", duration_ms: 0 }));
    const events = await collectUntil(handle, (e) => e.kind === "turn_end");
    const reason = events.find((e) => e.kind === "reasoning");
    expect(reason).toBeDefined();
    if (reason && reason.kind === "reasoning") {
      expect(reason.text).toBe("Let me think about this...");
    }
    await handle.shutdown("test");
  });
});

describe("AmpHandle — malformed line handling", () => {
  it("emits a non-fatal error for unparseable JSON lines and continues", async () => {
    const harness = makeFakeDriver();
    const { handle } = await makeHandleWith(harness);
    harness.pushLine("this is not json {");
    harness.pushLine(JSON.stringify({ type: "system", session_id: "s", model: "m" }));
    harness.pushLine(JSON.stringify({ type: "result", duration_ms: 0 }));
    const events = await collectUntil(handle, (e) => e.kind === "turn_end");
    const err = events.find((e) => e.kind === "error");
    expect(err).toBeDefined();
    if (err && err.kind === "error") {
      expect(err.errorCode).toBe("amp_protocol_error");
      expect(err.fatal).toBe(false);
      expect(err.retriable).toBe(false);
    }
    expect(events.some((e) => e.kind === "session_start")).toBe(true);
    expect(events.some((e) => e.kind === "turn_end")).toBe(true);
    await handle.shutdown("test");
  });
});

describe("AmpHandle — send() writes JSONL to stdin", () => {
  it("writes formatUserTurn(text) + newline to the driver", async () => {
    const harness = makeFakeDriver();
    const { handle } = await makeHandleWith(harness);
    await handle.send({ text: "do the thing" });
    expect(harness.stdinWrites).toHaveLength(1);
    const written = harness.stdinWrites[0];
    expect(written).toBeDefined();
    const parsed = JSON.parse(written ?? "{}");
    expect(parsed.type).toBe("user");
    expect(parsed.message.content[0].text).toBe("do the thing");
    await handle.shutdown("test");
  });

  it("rejects send while a turn is already active", async () => {
    const harness = makeFakeDriver();
    const { handle } = await makeHandleWith(harness);
    await handle.send({ text: "first turn" });
    await expect(handle.send({ text: "second" })).rejects.toThrow(/while a turn is already active/);
    await handle.shutdown("test");
  });

  it("rejects send after shutdown", async () => {
    const harness = makeFakeDriver();
    const { handle } = await makeHandleWith(harness);
    await handle.shutdown("test");
    await expect(handle.send({ text: "after shutdown" })).rejects.toThrow(/after shutdown/);
  });

  it("keeps stdin open between consecutive turns", async () => {
    const harness = makeFakeDriver();
    const { handle } = await makeHandleWith(harness);
    // First turn: send + drain to turn_end.
    harness.pushLine(JSON.stringify({ type: "system", session_id: "s", model: "m" }));
    await handle.send({ text: "first" });
    harness.pushLine(JSON.stringify({ type: "result", duration_ms: 0 }));
    await collectUntil(handle, (e) => e.kind === "turn_end");
    // stdin is still open, so a second send succeeds.
    expect(harness.stdinClosed()).toBe(false);
    await handle.send({ text: "second" });
    expect(harness.stdinWrites).toHaveLength(2);
    await handle.shutdown("test");
  });
});

describe("AmpHandle — interrupt()", () => {
  it("closes stdin and forces a turn_end", async () => {
    const harness = makeFakeDriver();
    const { handle } = await makeHandleWith(harness);
    harness.pushLine(JSON.stringify({ type: "system", session_id: "s", model: "m" }));
    await handle.send({ text: "hang" });
    await handle.interrupt("user asked");
    expect(harness.stdinClosed()).toBe(true);
    // Consume events until turn_end.
    const events = await collectUntil(handle, (e) => e.kind === "turn_end");
    expect(events.some((e) => e.kind === "interrupt")).toBe(true);
    expect(events.some((e) => e.kind === "turn_end")).toBe(true);
    await handle.shutdown("test");
  });
});

describe("AmpHandle — shutdown()", () => {
  it("emits session_end and closes the driver exactly once", async () => {
    const harness = makeFakeDriver();
    const { handle } = await makeHandleWith(harness);
    harness.pushLine(JSON.stringify({ type: "system", session_id: "s", model: "m" }));
    await handle.shutdown("test done");
    // Second shutdown is idempotent.
    await handle.shutdown("again");
    expect(harness.closed()).toBe(true);
  });

  it("stdin-close → clean shutdown drains remaining buffered events", async () => {
    const harness = makeFakeDriver();
    const { handle } = await makeHandleWith(harness);
    harness.pushLine(JSON.stringify({ type: "system", session_id: "s", model: "m" }));
    harness.pushLine(
      JSON.stringify({
        type: "assistant",
        message: { id: "m-1", content: [{ type: "text", text: "bye" }] },
      }),
    );
    // No `{type:"result"}` — simulate stdout EOF.
    harness.closeStdout();
    // shutdown should reap the driver without hanging.
    await handle.shutdown("eof");
    expect(harness.closed()).toBe(true);
  });
});

describe("AmpHandle — G4 gate on tool_use (advisory)", () => {
  it("emits error + forces turn_end when an out-of-worktree write is attempted", async () => {
    const harness = makeFakeDriver();
    const { handle } = await makeHandleWith(harness, ROOT_DIR);
    harness.pushLine(JSON.stringify({ type: "system", session_id: "s", model: "m" }));
    harness.pushLine(
      JSON.stringify({
        type: "assistant",
        message: {
          id: "m-bad",
          content: [
            {
              type: "tool_use",
              id: "toolu_bad",
              name: "write",
              input: { file_path: "/etc/shamu_probe.txt", content: "x" },
            },
          ],
        },
      }),
    );
    const events = await collectUntil(handle, (e) => e.kind === "turn_end");
    const err = events.find((e) => e.kind === "error");
    expect(err).toBeDefined();
    if (err && err.kind === "error") {
      expect(err.errorCode).toBe("path_scope_violation");
    }
    // Stdin should have been closed to signal amp to stop.
    expect(harness.stdinClosed()).toBe(true);
    await handle.shutdown("test");
  });
});
