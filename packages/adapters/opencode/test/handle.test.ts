/**
 * Unit tests for `OpencodeHandle` + event projection. Drives synthetic SDK
 * events through the projector and asserts the normalized `AgentEvent`
 * stream matches the contract shapes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk";
import type { AgentEvent } from "@shamu/adapters-base";
import { newRunId } from "@shamu/shared/ids";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createOpencodeAdapter,
  type OpencodeDriver,
  type OpencodeSdkClient,
} from "../src/index.ts";

let ROOT_DIR: string;

beforeAll(() => {
  ROOT_DIR = mkdtempSync(join(tmpdir(), "shamu-opencode-handle-"));
});

afterAll(() => {
  rmSync(ROOT_DIR, { recursive: true, force: true });
});

interface DriverHarness {
  readonly driver: OpencodeDriver;
  /** Push a synthetic SDK event into the subscribed stream. */
  pushEvent(ev: OpencodeEvent): void;
  /** Close the stream (simulates server shutdown). */
  closeStream(): void;
  /** Snapshot of calls made to session.prompt. */
  readonly promptCalls: Array<{ id: string; text: string }>;
  readonly abortCalls: string[];
}

function makeHarness(initialSessionId = "sess-h-1"): DriverHarness {
  const queue: OpencodeEvent[] = [];
  const waiters: Array<(ev: IteratorResult<OpencodeEvent>) => void> = [];
  let streamClosed = false;
  let driverClosed = false;
  const promptCalls: Array<{ id: string; text: string }> = [];
  const abortCalls: string[] = [];

  const client: OpencodeSdkClient = {
    session: {
      async create() {
        return { data: { id: initialSessionId } };
      },
      async get(args) {
        return { data: { id: args.path.id } };
      },
      async prompt(args) {
        const text = args.body.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
        promptCalls.push({ id: args.path.id, text });
        return { data: {} };
      },
      async abort(args) {
        abortCalls.push(args.path.id);
        return { data: true };
      },
    },
    event: {
      async subscribe() {
        async function* gen(): AsyncGenerator<OpencodeEvent, void, unknown> {
          while (!streamClosed) {
            const buffered = queue.shift();
            if (buffered) {
              yield buffered;
              continue;
            }
            const next = await new Promise<IteratorResult<OpencodeEvent>>((resolve) => {
              waiters.push(resolve);
            });
            if (next.done) return;
            yield next.value;
          }
        }
        return { stream: gen() };
      },
    },
    auth: {
      async set() {
        return { data: true };
      },
    },
  };

  const driver: OpencodeDriver = {
    client,
    async close() {
      driverClosed = true;
      streamClosed = true;
      while (waiters.length > 0) {
        const w = waiters.shift();
        if (w) w({ value: undefined, done: true });
      }
    },
  };
  void driverClosed;

  return {
    driver,
    pushEvent(ev) {
      if (streamClosed) return;
      const w = waiters.shift();
      if (w) w({ value: ev, done: false });
      else queue.push(ev);
    },
    closeStream() {
      streamClosed = true;
      while (waiters.length > 0) {
        const w = waiters.shift();
        if (w) w({ value: undefined, done: true });
      }
    },
    promptCalls,
    abortCalls,
  };
}

async function drainUntil(
  events: AsyncIterable<AgentEvent>,
  kind: AgentEvent["kind"],
  timeoutMs = 1000,
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

describe("OpencodeHandle — event mapping", () => {
  let harness: DriverHarness;

  beforeEach(() => {
    harness = makeHarness("sess-h-1");
  });

  afterEach(() => {
    // No-op; per-test shutdown closes drivers. This hook exists for future
    // resource tracking if we ever add temp dirs here.
  });

  it("emits session_start from session.created and turn_end from session.idle", async () => {
    const adapter = createOpencodeAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });

    // Script the vendor event stream.
    const sid = "sess-h-1";
    harness.pushEvent({
      type: "session.created",
      properties: {
        info: {
          id: sid,
          projectID: "p",
          directory: "/tmp",
          title: "t",
          version: "v",
          time: { created: 0, updated: 0 },
        },
      },
    } as OpencodeEvent);

    await handle.send({ text: "hello" });

    // Real server announces the assistant message before streaming parts.
    // The projector uses this to distinguish assistant text from echoed
    // user-prompt text.
    harness.pushEvent({
      type: "message.updated",
      properties: {
        info: {
          id: "msg-1",
          sessionID: sid,
          role: "assistant",
          time: { created: 0 },
          parentID: "msg-0",
          providerID: "opencode",
          modelID: "claude-haiku-4-5",
          mode: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      },
    } as OpencodeEvent);

    harness.pushEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-1",
          sessionID: sid,
          messageID: "msg-1",
          type: "text",
          text: "hi there",
        },
      },
    } as OpencodeEvent);

    harness.pushEvent({
      type: "session.idle",
      properties: { sessionID: sid },
    } as OpencodeEvent);

    const events = await drainUntil(handle.events, "turn_end", 2000);
    const kinds = events.map((e) => e.kind);

    expect(kinds).toContain("session_start");
    expect(kinds).toContain("assistant_delta");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("cost");
    expect(kinds).toContain("turn_end");

    // runId invariant — every event carries the orchestrator id.
    for (const ev of events) {
      expect(ev.runId).toBe(handle.runId);
    }

    await handle.shutdown("test");
  });

  it("emits tool_call + tool_result with parentEventId linkage", async () => {
    const adapter = createOpencodeAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });

    const sid = "sess-h-1";
    harness.pushEvent({
      type: "session.created",
      properties: {
        info: {
          id: sid,
          projectID: "p",
          directory: "/tmp",
          title: "t",
          version: "v",
          time: { created: 0, updated: 0 },
        },
      },
    } as OpencodeEvent);
    await handle.send({ text: "use a tool" });

    harness.pushEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "tp-1",
          sessionID: sid,
          messageID: "msg-1",
          type: "tool",
          callID: "call-A",
          tool: "read",
          state: { status: "running", input: { path: "README.md" }, time: { start: 0 } },
        },
      },
    } as OpencodeEvent);

    harness.pushEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "tp-1",
          sessionID: sid,
          messageID: "msg-1",
          type: "tool",
          callID: "call-A",
          tool: "read",
          state: {
            status: "completed",
            input: { path: "README.md" },
            output: "file contents here",
            title: "read",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        },
      },
    } as OpencodeEvent);

    harness.pushEvent({
      type: "session.idle",
      properties: { sessionID: sid },
    } as OpencodeEvent);

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

    await handle.shutdown("test");
  });

  it("path-scope violation in a pending tool call surfaces as error + abort", async () => {
    const adapter = createOpencodeAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });

    const sid = "sess-h-1";
    harness.pushEvent({
      type: "session.created",
      properties: {
        info: {
          id: sid,
          projectID: "p",
          directory: "/tmp",
          title: "t",
          version: "v",
          time: { created: 0, updated: 0 },
        },
      },
    } as OpencodeEvent);
    await handle.send({ text: "try to escape" });

    // Pending tool call whose path is OUTSIDE the cwd.
    harness.pushEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "tp-escape",
          sessionID: sid,
          messageID: "msg-1",
          type: "tool",
          callID: "call-escape",
          tool: "write",
          state: {
            status: "pending",
            input: { file_path: "/etc/shamu-escape.txt", content: "x" },
            raw: "",
          },
        },
      },
    } as OpencodeEvent);

    const events = await drainUntil(handle.events, "turn_end");
    const err = events.find((e) => e.kind === "error");
    expect(err?.kind).toBe("error");
    if (err && err.kind === "error") {
      expect(err.errorCode).toBe("path_scope_violation");
    }
    expect(harness.abortCalls).toContain(sid);

    await handle.shutdown("test");
  });

  it("shell-gate violation in a pending bash call surfaces as error + abort", async () => {
    const adapter = createOpencodeAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });

    const sid = "sess-h-1";
    harness.pushEvent({
      type: "session.created",
      properties: {
        info: {
          id: sid,
          projectID: "p",
          directory: "/tmp",
          title: "t",
          version: "v",
          time: { created: 0, updated: 0 },
        },
      },
    } as OpencodeEvent);
    await handle.send({ text: "run bash" });

    harness.pushEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "tp-bash",
          sessionID: sid,
          messageID: "msg-1",
          type: "tool",
          callID: "call-bash",
          tool: "bash",
          state: {
            status: "pending",
            input: { command: "echo $(whoami)" },
            raw: "",
          },
        },
      },
    } as OpencodeEvent);

    const events = await drainUntil(handle.events, "turn_end");
    const err = events.find((e) => e.kind === "error");
    expect(err?.kind).toBe("error");
    if (err && err.kind === "error") {
      expect(err.errorCode).toBe("shell_gate_violation");
    }
    expect(harness.abortCalls).toContain(sid);

    await handle.shutdown("test");
  });

  it("interrupt emits an interrupt event + turn_end", async () => {
    const adapter = createOpencodeAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: ROOT_DIR,
    });

    const sid = "sess-h-1";
    harness.pushEvent({
      type: "session.created",
      properties: {
        info: {
          id: sid,
          projectID: "p",
          directory: "/tmp",
          title: "t",
          version: "v",
          time: { created: 0, updated: 0 },
        },
      },
    } as OpencodeEvent);
    await handle.send({ text: "long-running" });

    // No idle / terminal event; we call interrupt().
    await handle.interrupt("test-interrupt");

    const events = await drainUntil(handle.events, "turn_end");
    expect(events.some((e) => e.kind === "interrupt")).toBe(true);
    expect(harness.abortCalls).toContain(sid);

    await handle.shutdown("test");
  });
});
