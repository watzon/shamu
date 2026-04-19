/**
 * Unit tests for the Pi RPC client: command/response correlation, timeout,
 * async event dispatch, protocol-error fanout, stdin backpressure (drain).
 */

import { describe, expect, it, vi } from "vitest";
import { PiCommandError, PiShutdownError, PiTimeoutError } from "../src/errors.ts";
import type { PiAsyncEvent, PiRpcTransport } from "../src/rpc-client.ts";
import { createPiRpcClient } from "../src/rpc-client.ts";

/**
 * A transport double with a push queue for inbound frames + a send log.
 */
function makeTransport(): {
  readonly transport: PiRpcTransport;
  readonly sent: string[];
  pushMessage(frame: object): void;
  readonly closed: () => boolean;
  /** Simulate transport-level send failure for the next write. */
  failNextSend(err: Error): void;
  /** Make stdin.write return a Promise (drain simulation). */
  setSendResolver(resolver: (() => Promise<void>) | null): void;
} {
  const sent: string[] = [];
  let closed = false;
  const pendingMessages: object[] = [];
  const waitQueue: Array<(v: IteratorResult<unknown>) => void> = [];
  let failErr: Error | null = null;
  let sendResolver: (() => Promise<void>) | null = null;

  async function* iter(): AsyncGenerator<unknown, void, unknown> {
    while (true) {
      const buffered = pendingMessages.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (closed) return;
      const next = await new Promise<IteratorResult<unknown>>((resolve) => {
        waitQueue.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }

  const transport: PiRpcTransport = {
    async send(frame: string): Promise<void> {
      if (failErr) {
        const e = failErr;
        failErr = null;
        throw e;
      }
      if (sendResolver) {
        await sendResolver();
      }
      sent.push(frame);
    },
    messages: iter(),
    async close(): Promise<void> {
      closed = true;
      while (waitQueue.length > 0) {
        const r = waitQueue.shift();
        if (r) r({ value: undefined, done: true });
      }
    },
  };
  return {
    transport,
    sent,
    pushMessage(frame) {
      const r = waitQueue.shift();
      if (r) r({ value: frame, done: false });
      else pendingMessages.push(frame);
    },
    closed: () => closed,
    failNextSend(err) {
      failErr = err;
    },
    setSendResolver(r) {
      sendResolver = r;
    },
  };
}

describe("PiRpcClient — command/response correlation", () => {
  it("resolves with `data` when the matching response arrives", async () => {
    const h = makeTransport();
    const client = createPiRpcClient(h.transport);
    const promise = client.sendCommand<{ ok: boolean }>("prompt", { message: "hi" });
    // Read the framed send — grab its id.
    expect(h.sent).toHaveLength(1);
    const frame = JSON.parse(h.sent[0] as string) as { id: string; type: string; message: string };
    expect(frame.type).toBe("prompt");
    expect(frame.message).toBe("hi");

    h.pushMessage({
      id: frame.id,
      type: "response",
      command: "prompt",
      success: true,
      data: { ok: true },
    });
    const result = await promise;
    expect(result).toEqual({ ok: true });
    await client.close();
  });

  it("rejects with PiCommandError when the response has success=false", async () => {
    const h = makeTransport();
    const client = createPiRpcClient(h.transport);
    const promise = client.sendCommand("set_model", { model: "bad/model" });
    const frame = JSON.parse(h.sent[0] as string) as { id: string };
    h.pushMessage({
      id: frame.id,
      type: "response",
      command: "set_model",
      success: false,
      error: "no such model",
    });
    await expect(promise).rejects.toBeInstanceOf(PiCommandError);
    await expect(promise).rejects.toThrow(/no such model/);
    await client.close();
  });

  it("rejects with PiTimeoutError when no response arrives in time", async () => {
    vi.useFakeTimers();
    try {
      const h = makeTransport();
      const client = createPiRpcClient(h.transport, { commandTimeoutMs: 100 });
      const promise = client.sendCommand("prompt", { message: "hi" });
      const spy = promise.catch((e) => e);
      await vi.advanceTimersByTimeAsync(150);
      const err = await spy;
      expect(err).toBeInstanceOf(PiTimeoutError);
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects synchronously when the client is already closed", async () => {
    const h = makeTransport();
    const client = createPiRpcClient(h.transport);
    await client.close();
    await expect(client.sendCommand("prompt")).rejects.toBeInstanceOf(PiShutdownError);
  });

  it("rejects pending commands on close() with PiShutdownError", async () => {
    const h = makeTransport();
    const client = createPiRpcClient(h.transport);
    const promise = client.sendCommand("prompt", { message: "hi" });
    await client.close();
    await expect(promise).rejects.toBeInstanceOf(PiShutdownError);
  });

  it("wraps transport send failures as PiCommandError", async () => {
    const h = makeTransport();
    h.failNextSend(new Error("pipe broken"));
    const client = createPiRpcClient(h.transport);
    await expect(client.sendCommand("prompt", { message: "hi" })).rejects.toBeInstanceOf(
      PiCommandError,
    );
    await client.close();
  });
});

describe("PiRpcClient — async event dispatch", () => {
  it("dispatches frames with no id to every onEvent subscriber", async () => {
    const h = makeTransport();
    const client = createPiRpcClient(h.transport);
    const seen1: PiAsyncEvent[] = [];
    const seen2: PiAsyncEvent[] = [];
    client.onEvent((ev) => seen1.push(ev));
    client.onEvent((ev) => seen2.push(ev));
    h.pushMessage({ type: "agent_start" });
    h.pushMessage({ type: "message_update", delta: "hi" });
    // Give the consume loop a tick to process.
    await new Promise((r) => setTimeout(r, 5));
    expect(seen1.map((e) => e.type)).toEqual(["agent_start", "message_update"]);
    expect(seen2.map((e) => e.type)).toEqual(["agent_start", "message_update"]);
    await client.close();
  });

  it("unsubscribe removes the handler", async () => {
    const h = makeTransport();
    const client = createPiRpcClient(h.transport);
    const seen: PiAsyncEvent[] = [];
    const off = client.onEvent((ev) => seen.push(ev));
    h.pushMessage({ type: "a" });
    await new Promise((r) => setTimeout(r, 5));
    off();
    h.pushMessage({ type: "b" });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.map((e) => e.type)).toEqual(["a"]);
    await client.close();
  });
});

describe("PiRpcClient — protocol errors", () => {
  it("fires onProtocolError for a non-object frame", async () => {
    const h = makeTransport();
    const client = createPiRpcClient(h.transport);
    const errors: string[] = [];
    client.onProtocolError((err) => errors.push(err.raw));
    h.pushMessage(42 as unknown as object);
    await new Promise((r) => setTimeout(r, 5));
    expect(errors.length).toBe(1);
    await client.close();
  });

  it("fires onProtocolError for a frame missing `type`", async () => {
    const h = makeTransport();
    const client = createPiRpcClient(h.transport);
    const errors: string[] = [];
    client.onProtocolError((err) => errors.push(err.raw));
    h.pushMessage({ id: "x", success: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(errors.length).toBe(1);
    await client.close();
  });

  it("fires onProtocolError for a response with an unknown id", async () => {
    const h = makeTransport();
    const client = createPiRpcClient(h.transport);
    const errors: string[] = [];
    client.onProtocolError((err) => errors.push(err.message));
    h.pushMessage({ id: "nope", type: "response", success: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/unknown id/);
    await client.close();
  });
});

describe("PiRpcClient — handshake", () => {
  it("consumes the first {type:ready} frame via onReady without dispatching it to onEvent", async () => {
    const h = makeTransport();
    const client = createPiRpcClient(h.transport);
    const seenEvents: PiAsyncEvent[] = [];
    const seenReady: PiAsyncEvent[] = [];
    client.onEvent((ev) => seenEvents.push(ev));
    client.onReady((ev) => seenReady.push(ev));
    h.pushMessage({ type: "ready", version: "0.67" });
    h.pushMessage({ type: "agent_start" });
    await new Promise((r) => setTimeout(r, 10));
    expect(seenReady).toHaveLength(1);
    expect(seenEvents.map((e) => e.type)).toEqual(["agent_start"]);
    await client.close();
  });
});

describe("PiRpcClient — stdin drain (backpressure)", () => {
  it("awaits the transport's promise-returning send (Node-style drain)", async () => {
    const h = makeTransport();
    let released = false;
    let release = () => {};
    h.setSendResolver(
      () =>
        new Promise<void>((r) => {
          release = () => {
            released = true;
            r();
          };
        }),
    );
    const client = createPiRpcClient(h.transport);
    // Send a command; its internal `transport.send` will block until we
    // release. The outer sendCommand promise should NOT resolve yet — it
    // still needs a response — but we verify that `sent` hasn't landed.
    const promise = client.sendCommand("prompt", { message: "hi" });
    promise.catch(() => {
      // we'll close shortly; ignore the rejection path
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.sent).toHaveLength(0);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(released).toBe(true);
    expect(h.sent).toHaveLength(1);
    await client.close();
  });
});
