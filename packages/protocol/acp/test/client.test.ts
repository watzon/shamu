/**
 * Unit tests for the ACP client.
 *
 * Exercises the full request/response/notification/server-request lifecycle
 * against a scripted in-memory transport. No subprocesses, no real JSON
 * parsing on the wire — the transport surface is object-in/object-out.
 *
 * Scenarios covered:
 *  - initialize round-trip + method dictionary
 *  - request timeout rejection
 *  - notification dispatch (session/update)
 *  - server-initiated `session/request_permission`
 *  - close rejects every pending request with AcpShutdownError
 *  - stray responses with unknown ids surface as protocol errors
 *  - malformed incoming frames surface as protocol errors
 */

import { describe, expect, it } from "vitest";
import {
  type AcpClient,
  type AcpJsonRpcTransport,
  AcpProtocolError,
  AcpRpcError,
  AcpShutdownError,
  AcpTimeoutError,
  createAcpClient,
} from "../src/index.ts";

/** Scripted transport — tests push inbound frames and observe outbound ones. */
function makeHarness() {
  const outbound: object[] = [];
  const inbound: object[] = [];
  const waiters: Array<(v: IteratorResult<unknown>) => void> = [];
  let closed = false;

  const pushInbound = (frame: object): void => {
    if (closed) return;
    const w = waiters.shift();
    if (w) w({ value: frame, done: false });
    else inbound.push(frame);
  };

  const closeStream = (): void => {
    closed = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (w) w({ value: undefined, done: true });
    }
  };

  const transport: AcpJsonRpcTransport = {
    async send(frame) {
      outbound.push(frame);
    },
    messages: {
      [Symbol.asyncIterator](): AsyncIterator<unknown> {
        return {
          async next() {
            const buffered = inbound.shift();
            if (buffered !== undefined) return { value: buffered, done: false };
            if (closed) return { value: undefined, done: true };
            return new Promise<IteratorResult<unknown>>((resolve) => waiters.push(resolve));
          },
        };
      },
    },
    async close() {
      closeStream();
    },
  };

  return { transport, outbound, pushInbound, closeStream };
}

/** Wait one microtask tick so queued I/O can settle. */
function tick(n = 1): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => {});
  return p;
}

describe("AcpClient — request/response correlation", () => {
  it("resolves `initialize` when a matching response arrives", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport);
    const pending = client.initialize({
      protocolVersion: 1,
      clientInfo: { name: "shamu-test" },
    });
    await tick();
    expect(h.outbound.length).toBe(1);
    const req = h.outbound[0] as { id: number | string; method: string };
    expect(req.method).toBe("initialize");
    h.pushInbound({
      jsonrpc: "2.0",
      id: req.id,
      result: { protocolVersion: 1, agentInfo: { name: "fake-agent" } },
    });
    const result = await pending;
    expect(result.agentInfo?.name).toBe("fake-agent");
    await client.close();
  });

  it("maps JSON-RPC error responses to AcpRpcError", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport);
    const pending = client.newSession({ cwd: "/tmp" });
    await tick();
    const req = h.outbound[0] as { id: number | string };
    h.pushInbound({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32001, message: "boom", data: { detail: "x" } },
    });
    await expect(pending).rejects.toBeInstanceOf(AcpRpcError);
    await client.close();
  });

  it("rejects with AcpTimeoutError when no response arrives", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport, { requestTimeoutMs: 20 });
    await expect(client.initialize({ protocolVersion: 1 })).rejects.toBeInstanceOf(AcpTimeoutError);
    await client.close();
  });

  it("protocol-errors on a response with an unknown id", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport);
    const errors: AcpProtocolError[] = [];
    client.onProtocolError((e) => errors.push(e));
    h.pushInbound({ jsonrpc: "2.0", id: 999, result: {} });
    await tick(3);
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(AcpProtocolError);
    await client.close();
  });

  it("protocol-errors on a frame without the jsonrpc marker", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport);
    const errors: AcpProtocolError[] = [];
    client.onProtocolError((e) => errors.push(e));
    // Missing jsonrpc field
    h.pushInbound({ id: 1, result: "bare" });
    await tick(3);
    expect(errors.length).toBe(1);
    await client.close();
  });
});

describe("AcpClient — notifications", () => {
  it("delivers session/update to every subscriber", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport);
    const received: Array<{ sessionId: string; kind: string }> = [];
    client.onSessionUpdate((ev) =>
      received.push({
        sessionId: ev.sessionId,
        kind: String((ev.update as { sessionUpdate?: string }).sessionUpdate ?? ""),
      }),
    );
    h.pushInbound({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s-1", update: { sessionUpdate: "assistant_message_chunk" } },
    });
    await tick(3);
    expect(received).toEqual([{ sessionId: "s-1", kind: "assistant_message_chunk" }]);
    await client.close();
  });

  it("allows multiple subscribers and supports unsubscribe", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport);
    const a: string[] = [];
    const b: string[] = [];
    const off = client.onSessionUpdate((ev) => a.push(ev.sessionId));
    client.onSessionUpdate((ev) => b.push(ev.sessionId));
    h.pushInbound({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s-2", update: { sessionUpdate: "x" } },
    });
    await tick(3);
    off();
    h.pushInbound({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s-3", update: { sessionUpdate: "x" } },
    });
    await tick(3);
    expect(a).toEqual(["s-2"]);
    expect(b).toEqual(["s-2", "s-3"]);
    await client.close();
  });
});

describe("AcpClient — server-initiated requests", () => {
  it("dispatches session/request_permission to the registered handler and returns its decision", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport);
    client.onPermissionRequest(async () => ({
      outcome: "selected",
      optionId: "allow_once",
    }));
    h.pushInbound({
      jsonrpc: "2.0",
      id: 42,
      method: "session/request_permission",
      params: {
        sessionId: "s-1",
        toolCall: { toolCallId: "tc-1", name: "write" },
        options: [{ optionId: "allow_once" }, { optionId: "reject_once" }],
      },
    });
    // Let the handler + response send round-trip.
    await tick(5);
    const responseFrame = h.outbound.find((f) => (f as { id?: unknown }).id === 42) as {
      result: { outcome: { outcome: string; optionId: string } };
    };
    expect(responseFrame).toBeDefined();
    expect(responseFrame.result.outcome.outcome).toBe("selected");
    expect(responseFrame.result.outcome.optionId).toBe("allow_once");
    await client.close();
  });

  it("returns -32601 when no permission handler is registered", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport);
    h.pushInbound({
      jsonrpc: "2.0",
      id: 7,
      method: "session/request_permission",
      params: {
        sessionId: "s-1",
        toolCall: { toolCallId: "tc-1" },
        options: [{ optionId: "a" }],
      },
    });
    await tick(5);
    const responseFrame = h.outbound.find((f) => (f as { id?: unknown }).id === 7) as {
      error: { code: number };
    };
    expect(responseFrame.error.code).toBe(-32601);
    await client.close();
  });

  it("dispatches custom server-request handlers via onServerRequest", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport);
    client.onServerRequest("fs/read", async (params) => ({
      echoed: (params as { path: string }).path,
    }));
    h.pushInbound({
      jsonrpc: "2.0",
      id: 100,
      method: "fs/read",
      params: { path: "/etc/hosts" },
    });
    await tick(5);
    const res = h.outbound.find((f) => (f as { id?: unknown }).id === 100) as {
      result: { echoed: string };
    };
    expect(res.result.echoed).toBe("/etc/hosts");
    await client.close();
  });
});

describe("AcpClient — close semantics", () => {
  it("rejects every pending request with AcpShutdownError on close", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport, { requestTimeoutMs: 5000 });
    const a = client.initialize({ protocolVersion: 1 });
    const b = client.newSession({ cwd: "/tmp" });
    await tick();
    await client.close();
    await expect(a).rejects.toBeInstanceOf(AcpShutdownError);
    await expect(b).rejects.toBeInstanceOf(AcpShutdownError);
  });

  it("rejects sendRequest after close with AcpShutdownError", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport);
    await client.close();
    await expect(client.initialize({ protocolVersion: 1 })).rejects.toBeInstanceOf(
      AcpShutdownError,
    );
  });

  it("close is idempotent", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport);
    await client.close();
    await client.close();
    expect(true).toBe(true);
  });
});

describe("AcpClient — authenticate + cancelSession", () => {
  it("authenticate sends the correct method frame", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport);
    const p = client.authenticate("cursor_login", { apiKey: "x" });
    await tick();
    const req = h.outbound[0] as {
      method: string;
      params: { methodId: string; apiKey: string };
      id: number;
    };
    expect(req.method).toBe("authenticate");
    expect(req.params.methodId).toBe("cursor_login");
    expect(req.params.apiKey).toBe("x");
    h.pushInbound({ jsonrpc: "2.0", id: req.id, result: {} });
    await p;
    await client.close();
  });

  it("cancelSession sends a notification (no id)", async () => {
    const h = makeHarness();
    const client = createAcpClient(h.transport);
    await client.cancelSession("s-xyz");
    await tick();
    const notif = h.outbound.find(
      (f): f is { method: string; params: { sessionId: string }; id?: undefined } =>
        (f as { method?: string }).method === "session/cancel",
    );
    expect(notif).toBeDefined();
    expect((notif as { id?: unknown }).id).toBeUndefined();
    await client.close();
  });
});

describe("AcpClient — prompt with timeout override", () => {
  it("prompt(...) honors per-call timeoutMs", async () => {
    const h = makeHarness();
    const client: AcpClient = createAcpClient(h.transport, { requestTimeoutMs: 10_000 });
    const p = client.prompt(
      { sessionId: "s", prompt: [{ type: "text", text: "hi" }] },
      { timeoutMs: 20 },
    );
    await expect(p).rejects.toBeInstanceOf(AcpTimeoutError);
    await client.close();
  });
});
