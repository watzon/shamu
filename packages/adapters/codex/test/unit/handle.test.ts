/**
 * Behavioral tests for `CodexHandle` via the `CodexAdapter` surface.
 *
 * Uses a scripted `FakeCodex` / `FakeThread` in place of the real SDK so
 * the tests run fast and hermetic. Covers:
 *
 * - `runId` invariant: `spawn(opts).runId === opts.runId` (G8).
 * - Thread-id persistence: sessionId is bound from `thread.started`, and
 *   `resume(sid)` round-trips it.
 * - Redaction scrubs planted secrets before events leave the handle.
 * - `setPermissionMode` rejects modes not declared in the manifest.
 * - Path-scope denial on `file_change` surfaces an error event and aborts
 *   the turn.
 */

import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import type { AgentEvent, AgentHandle } from "@shamu/adapters-base";
import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { CodexAdapter, type CodexLike, type ThreadLike } from "../../src/index.ts";
import { echoScript, FakeCodex, FakeThread } from "../fake-thread.ts";

const PLANTED_SECRET = "sk-ant-FAKE-FIXTURE-aAbBcCdDeEfFgGhHiI123456";

function makeAdapter(
  scripts: Array<(input: string, signal: AbortSignal | undefined) => ThreadEvent[]>,
): CodexAdapter {
  return new CodexAdapter({
    codexFactory: (_sdkOpts): CodexLike =>
      new FakeCodex(
        (kind, id) =>
          new FakeThread({
            id: kind === "resume" ? id : null,
            scripts,
          }),
      ),
  });
}

async function collectTurn(handle: AgentHandle, budgetMs = 2_000): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const iter = handle.events[Symbol.asyncIterator]();
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const next = await iter.next();
    if (next.done) break;
    events.push(next.value);
    if (next.value.kind === "turn_end") break;
  }
  return events;
}

describe("CodexAdapter: runId invariant (G8)", () => {
  it("handle.runId === opts.runId", async () => {
    const adapter = makeAdapter([echoScript]);
    const runId = newRunId();
    const handle = await adapter.spawn({
      cwd: "/tmp",
      runId,
      vendorCliPath: "/fake/codex",
    });
    expect(handle.runId).toBe(runId);
    await handle.shutdown("done");
  });
});

describe("CodexAdapter: spawn basic flow", () => {
  it("emits session_start → assistant_message → usage → cost → turn_end", async () => {
    const adapter = makeAdapter([echoScript]);
    const handle = await adapter.spawn({
      cwd: "/tmp",
      runId: newRunId(),
      vendorCliPath: "/fake/codex",
    });
    await handle.send({ text: "hello" });
    const events = await collectTurn(handle);
    await handle.shutdown("done");

    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("session_start");
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("cost");
    expect(kinds[kinds.length - 1]).toBe("turn_end");
  });

  it("binds sessionId from the Codex thread.started event", async () => {
    const adapter = makeAdapter([echoScript]);
    const handle = await adapter.spawn({
      cwd: "/tmp",
      runId: newRunId(),
      vendorCliPath: "/fake/codex",
    });
    expect(handle.sessionId).toBeNull();
    await handle.send({ text: "hello" });
    await collectTurn(handle);
    expect(handle.sessionId).toBe("thr_echo_0001");
    await handle.shutdown("done");
  });
});

describe("CodexAdapter: resume", () => {
  it("resume(sid) surfaces sessionId before the first send", async () => {
    const adapter = makeAdapter([echoScript]);
    const handle = await adapter.resume("thr_existing_42" as never, {
      cwd: "/tmp",
      runId: newRunId(),
      vendorCliPath: "/fake/codex",
    });
    expect(handle.sessionId).toBe("thr_existing_42");
    await handle.shutdown("done");
  });

  it("resumed stream emits session_start with source=resume", async () => {
    const adapter = makeAdapter([echoScript]);
    const handle = await adapter.resume("thr_existing_42" as never, {
      cwd: "/tmp",
      runId: newRunId(),
      vendorCliPath: "/fake/codex",
    });
    await handle.send({ text: "hi" });
    const events = await collectTurn(handle);
    await handle.shutdown("done");
    const start = events.find((e) => e.kind === "session_start");
    expect(start).toBeDefined();
    if (start?.kind !== "session_start") throw new Error("expected session_start");
    expect(start.source).toBe("resume");
  });
});

describe("CodexAdapter: redaction", () => {
  it("scrubs planted secrets before events leave the handle", async () => {
    // Build a script that plants the secret in the agent's response so
    // the adapter's redactor has something to scrub.
    const secretScript = (_input: string): ThreadEvent[] => [
      { type: "thread.started", thread_id: "thr_s" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "i0",
          type: "agent_message",
          text: `here is the token: ${PLANTED_SECRET}`,
        },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];
    const adapter = makeAdapter([secretScript]);
    const handle = await adapter.spawn({
      cwd: "/tmp",
      runId: newRunId(),
      vendorCliPath: "/fake/codex",
    });
    await handle.send({ text: `echo this: ${PLANTED_SECRET}` });
    const events = await collectTurn(handle);
    await handle.shutdown("done");

    for (const ev of events) {
      const body = JSON.stringify(ev);
      expect(body).not.toContain(PLANTED_SECRET);
      expect(body).not.toContain("sk-ant-FAKE");
    }
  });
});

describe("CodexAdapter: setPermissionMode", () => {
  it("rejects modes not declared in the manifest", async () => {
    const adapter = makeAdapter([echoScript]);
    const handle = await adapter.spawn({
      cwd: "/tmp",
      runId: newRunId(),
      vendorCliPath: "/fake/codex",
    });
    try {
      // "plan" is a valid PermissionMode but not declared in Codex's manifest.
      await expect(handle.setPermissionMode("plan")).rejects.toThrow(/not declared/);
      // Each declared mode must succeed.
      await expect(handle.setPermissionMode("default")).resolves.toBeUndefined();
      await expect(handle.setPermissionMode("acceptEdits")).resolves.toBeUndefined();
    } finally {
      await handle.shutdown("done");
    }
  });
});

describe("CodexAdapter: path-scope enforcement", () => {
  it("denied file_change surfaces a tool_call + error + aborts the turn", async () => {
    const denyScript = (_input: string): ThreadEvent[] => [
      { type: "thread.started", thread_id: "thr_deny" },
      { type: "turn.started" },
      {
        type: "item.started",
        item: {
          id: "fc_bad",
          type: "file_change",
          changes: [{ path: "/etc/passwd", kind: "update" }],
          status: "completed",
        },
      },
      // Further events would arrive but the handle aborts before reading.
      {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];
    const adapter = makeAdapter([denyScript]);
    const handle = await adapter.spawn({
      cwd: "/tmp",
      runId: newRunId(),
      vendorCliPath: "/fake/codex",
    });
    await handle.send({ text: "write outside" });

    const iter = handle.events[Symbol.asyncIterator]();
    const seen: AgentEvent[] = [];
    const budget = Date.now() + 2_000;
    while (Date.now() < budget) {
      const next = await iter.next();
      if (next.done) break;
      seen.push(next.value);
      if (next.value.kind === "error") break;
    }
    await handle.shutdown("done");

    const err = seen.find((e) => e.kind === "error");
    expect(err).toBeDefined();
    if (err?.kind !== "error") throw new Error("expected error");
    expect(err.errorCode).toBe("path_scope_violation");
  });
});

describe("CodexAdapter: auth resolution at spawn", () => {
  it("throws when neither vendorCliPath nor CODEX_API_KEY is present", async () => {
    const priorKey = process.env.CODEX_API_KEY;
    delete process.env.CODEX_API_KEY;
    const adapter = makeAdapter([echoScript]);
    try {
      await expect(adapter.spawn({ cwd: "/tmp", runId: newRunId() })).rejects.toThrow(
        /CODEX_API_KEY/,
      );
    } finally {
      if (priorKey !== undefined) process.env.CODEX_API_KEY = priorKey;
    }
  });
});

describe("CodexAdapter: empty-stream guard (Phase 9.B.1)", () => {
  it("emits synthetic session_start + error + turn_end when the SDK yields zero events", async () => {
    // Mirrors the Codex CLI's trusted-directory refusal: the process
    // exits 0 after printing a human diag, the SDK's readline iterator
    // finishes with zero events, and no `thread.started` ever fires.
    // Without the guard the adapter's event queue stays open forever.
    const emptyScript = (_input: string): ThreadEvent[] => [];
    const adapter = makeAdapter([emptyScript]);
    const handle = await adapter.spawn({
      cwd: "/tmp",
      runId: newRunId(),
      vendorCliPath: "/fake/codex",
    });
    await handle.send({ text: "hello" });
    const events = await collectTurn(handle);
    await handle.shutdown("done");

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("session_start");
    expect(kinds).toContain("error");
    expect(kinds[kinds.length - 1]).toBe("turn_end");

    const err = events.find((e) => e.kind === "error");
    if (err?.kind !== "error") throw new Error("expected error");
    expect(err.errorCode).toBe("vendor_empty_stream");
    expect(err.fatal).toBe(true);
    expect(err.retriable).toBe(false);

    const terminal = events[events.length - 1];
    if (terminal?.kind !== "turn_end") throw new Error("expected turn_end");
    expect(terminal.stopReason).toBe("vendor_empty_stream");
  });

  it("emits synthetic error + turn_end when the SDK throws before thread.started", async () => {
    // Simulates the SDK's JSON.parse throw on the "Reading prompt from
    // stdin..." plaintext line the Codex CLI emits pre-handshake. The
    // iterator rejects at the first `.next()` before any ThreadEvent
    // is yielded; without the fix `enqueueError` /
    // `emitSyntheticTurnEnd` would no-op because no turn is open and
    // the adapter's queue would hang indefinitely.
    const throwingIter: AsyncIterable<ThreadEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<ThreadEvent>> {
            return Promise.reject(new Error("Failed to parse item: Reading prompt from stdin..."));
          },
        };
      },
    };
    class ThrowingThread implements ThreadLike {
      public id: string | null = null;
      async runStreamed(): Promise<{ events: AsyncIterable<ThreadEvent> }> {
        return { events: throwingIter };
      }
    }
    const adapter = new CodexAdapter({
      codexFactory: (_sdkOpts): CodexLike => ({
        startThread: () => new ThrowingThread(),
        resumeThread: () => new ThrowingThread(),
      }),
    });
    const handle = await adapter.spawn({
      cwd: "/tmp",
      runId: newRunId(),
      vendorCliPath: "/fake/codex",
    });
    await handle.send({ text: "hello" });
    const events = await collectTurn(handle);
    await handle.shutdown("done");

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("error");
    expect(kinds[kinds.length - 1]).toBe("turn_end");

    const err = events.find((e) => e.kind === "error");
    if (err?.kind !== "error") throw new Error("expected error");
    expect(err.errorCode).toBe("stream_error");
    expect(err.message).toContain("Failed to parse item");
  });
});

describe("CodexAdapter: threadOptions wiring", () => {
  it("passes skipGitRepoCheck=true to the SDK ThreadOptions", async () => {
    // Regression guard for the Phase 9.B.1 live-smoke hang: without
    // skipGitRepoCheck the Codex CLI refuses to run outside a trusted
    // directory, emits a plaintext line, and exits 0 with zero JSONL
    // events. The orchestrator owns trust (path-scope + shell-gate);
    // Codex's own check is redundant and actively harmful to the UX.
    let captured: ThreadOptions | undefined;
    const adapter = new CodexAdapter({
      codexFactory: (_sdkOpts): CodexLike => ({
        startThread: (opts) => {
          captured = opts;
          return new FakeThread({ scripts: [echoScript] });
        },
        resumeThread: (_id, opts) => {
          captured = opts;
          return new FakeThread({ scripts: [echoScript] });
        },
      }),
    });
    const handle = await adapter.spawn({
      cwd: "/tmp",
      runId: newRunId(),
      vendorCliPath: "/fake/codex",
    });
    await handle.shutdown("done");
    expect(captured?.skipGitRepoCheck).toBe(true);
  });
});

describe("CodexAdapter: env threading", () => {
  it("threads SpawnOpts.env through to CodexOptions.env, merged on top of process.env", async () => {
    let captured: Record<string, string> | undefined;
    const adapter = new CodexAdapter({
      codexFactory: (sdkOpts): CodexLike => {
        captured = sdkOpts.env;
        return new FakeCodex(
          (kind, id) =>
            new FakeThread({
              id: kind === "resume" ? id : null,
              scripts: [echoScript],
            }),
        );
      },
    });
    const handle = await adapter.spawn({
      cwd: "/tmp",
      runId: newRunId(),
      vendorCliPath: "/fake/codex",
      env: {
        HTTPS_PROXY: "http://127.0.0.1:5555",
        HTTP_PROXY: "http://127.0.0.1:5555",
        NO_PROXY: "127.0.0.1,localhost",
      },
    });
    try {
      expect(captured?.HTTPS_PROXY).toBe("http://127.0.0.1:5555");
      expect(captured?.HTTP_PROXY).toBe("http://127.0.0.1:5555");
      expect(captured?.NO_PROXY).toBe("127.0.0.1,localhost");
      // process.env was materialized underneath (the SDK's env option
      // suppresses process.env inheritance, so we carry it forward
      // explicitly).
      if (process.env.PATH) expect(captured?.PATH).toBe(process.env.PATH);
    } finally {
      await handle.shutdown("done");
    }
  });

  it("omits CodexOptions.env entirely when SpawnOpts.env is absent", async () => {
    let called = false;
    let captured: Record<string, string> | undefined;
    const adapter = new CodexAdapter({
      codexFactory: (sdkOpts): CodexLike => {
        called = true;
        captured = sdkOpts.env;
        return new FakeCodex(
          (kind, id) =>
            new FakeThread({
              id: kind === "resume" ? id : null,
              scripts: [echoScript],
            }),
        );
      },
    });
    const handle = await adapter.spawn({
      cwd: "/tmp",
      runId: newRunId(),
      vendorCliPath: "/fake/codex",
    });
    try {
      expect(called).toBe(true);
      expect(captured).toBeUndefined();
    } finally {
      await handle.shutdown("done");
    }
  });
});
