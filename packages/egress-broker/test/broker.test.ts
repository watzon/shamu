/**
 * Broker integration tests.
 *
 * All tests run on loopback:
 *   - A local target HTTP server mocks `api.anthropic.com` — we don't
 *     actually resolve DNS; we allow `127.0.0.1` in the policy and point
 *     the upstream there. That's the whole point of a hermetic test.
 *   - A second loopback "attacker" target is wired up but NOT in the
 *     allow-list; the proxy must refuse both CONNECT and direct-HTTP.
 *
 * Notes on methodology:
 *   - For plaintext HTTP, we use `http.request` with `host: 127.0.0.1`,
 *     `port: broker.port`, and `path: "http://<target>/..."` (absolute-form
 *     request URI per RFC 7230 § 5.3.2). This is exactly what `curl -x` +
 *     subprocesses with `HTTP_PROXY` do.
 *   - For CONNECT, we use `http.request` with `method: "CONNECT"` and the
 *     `:method CONNECT host:port HTTP/1.1` line is emitted automatically
 *     when we pass `path: "target:port"`.
 */

import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
} from "node:http";
import { type AddressInfo, createServer, connect as netConnect, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEgressBroker,
  type EgressBrokerHandle,
  type PolicyEgressAllowedEvent,
  type PolicyEgressDeniedEvent,
  policyFromAllowlist,
} from "../src/index.ts";

/**
 * Plaintext HTTP target for forwarded-request tests. Responds with a
 * canned body + captures the last-seen Host header so the test can
 * verify the proxy rewrote paths correctly.
 */
async function startLocalHttpTarget(): Promise<{
  port: number;
  lastRequest: () => { method: string; url: string; host: string | undefined };
  close: () => Promise<void>;
}> {
  let last: { method: string; url: string; host: string | undefined } = {
    method: "",
    url: "",
    host: undefined,
  };
  const server = createHttpServer((req, res) => {
    last = {
      method: req.method ?? "",
      url: req.url ?? "",
      host: req.headers.host,
    };
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok-target\n");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    lastRequest: () => last,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Raw TCP target for CONNECT-tunnel tests. It doesn't speak HTTP — the
 * point of the broker is that the tunnel is opaque: once the client sends
 * its bytes after the 200 Connection Established, they land on this
 * socket verbatim. We have the server echo bytes back so the test can
 * assert the tunnel carries payload.
 */
async function startEchoTcpTarget(): Promise<{
  port: number;
  close: () => Promise<void>;
  server: Server;
}> {
  const server = createServer((sock) => {
    sock.on("data", (chunk) => {
      try {
        sock.write(chunk);
      } catch {
        // ignore
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Send a plaintext HTTP request through the broker. Uses the absolute-URI
 * request form that proxies expect.
 */
function requestViaProxy(
  broker: EgressBrokerHandle,
  absoluteUrl: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(absoluteUrl);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: broker.port,
        method: "GET",
        path: absoluteUrl,
        headers: { host: url.host },
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Open a CONNECT tunnel through the broker. Resolves with the raw socket
 * once `200 Connection Established` has been received, OR with an object
 * describing the rejection.
 *
 * We write the CONNECT request manually over a plain TCP socket instead of
 * using Node's `http.request`. The high-level client routes body delivery
 * differently across Node versions on non-2xx CONNECT responses (body
 * sometimes on `res`, sometimes on the raw socket); raw bytes sidestep
 * the inconsistency and let the test assert the exact wire response.
 */
type ConnectResult =
  | {
      kind: "established";
      write: (b: Buffer) => void;
      read: () => Promise<Buffer>;
      end: () => void;
    }
  | { kind: "rejected"; statusCode: number; body: string };

function connectViaProxy(broker: EgressBrokerHandle, target: string): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(broker.port, "127.0.0.1");
    let settled = false;
    const settle = (v: ConnectResult): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    sock.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    let headerBuf = Buffer.alloc(0);
    let mode: "header" | "tunnel" | "body" = "header";
    // Tunnel-mode state (set once we see 200 Connection Established).
    const tunnelBuffered: Buffer[] = [];
    const tunnelWaiters: Array<(b: Buffer) => void> = [];
    // Rejection-mode state (non-2xx).
    const bodyChunks: Buffer[] = [];
    let rejectStatus = 0;

    const deliverTunnel = (chunk: Buffer): void => {
      if (tunnelWaiters.length > 0) {
        const w = tunnelWaiters.shift();
        if (w) w(chunk);
      } else {
        tunnelBuffered.push(chunk);
      }
    };

    const finalizeReject = (): void => {
      settle({
        kind: "rejected",
        statusCode: rejectStatus,
        body: Buffer.concat(bodyChunks).toString("utf8"),
      });
    };
    sock.on("close", () => {
      if (mode === "body") finalizeReject();
    });
    sock.on("end", () => {
      if (mode === "body") finalizeReject();
    });

    sock.on("data", (chunk: Buffer) => {
      if (mode === "tunnel") {
        deliverTunnel(chunk);
        return;
      }
      if (mode === "body") {
        bodyChunks.push(chunk);
        return;
      }
      // mode === "header"
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const sepIdx = headerBuf.indexOf("\r\n\r\n");
      if (sepIdx < 0) return;
      const headerText = headerBuf.slice(0, sepIdx).toString("utf8");
      const rest = headerBuf.slice(sepIdx + 4);
      const firstLineEnd = headerText.indexOf("\r\n");
      const statusLine = firstLineEnd >= 0 ? headerText.slice(0, firstLineEnd) : headerText;
      const parts = statusLine.split(" ");
      const statusCode = Number.parseInt(parts[1] ?? "0", 10) || 0;

      if (statusCode === 200) {
        mode = "tunnel";
        if (rest.length > 0) tunnelBuffered.push(rest);
        settle({
          kind: "established",
          write: (b: Buffer) => {
            sock.write(b);
          },
          read: () =>
            new Promise<Buffer>((res2) => {
              if (tunnelBuffered.length > 0) {
                const next = tunnelBuffered.shift();
                if (next !== undefined) {
                  res2(next);
                  return;
                }
              }
              tunnelWaiters.push(res2);
            }),
          end: () => {
            try {
              sock.destroy();
            } catch {
              // ignore
            }
          },
        });
        return;
      }

      mode = "body";
      rejectStatus = statusCode;
      if (rest.length > 0) bodyChunks.push(rest);
      // If the server already closed, the close listener above won't fire
      // a second time; check writableEnded/readableEnded defensively.
      if (!sock.readable || sock.readableEnded) {
        finalizeReject();
      }
    });

    sock.once("connect", () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
  });
}

describe("createEgressBroker — lifecycle", () => {
  let broker: EgressBrokerHandle | null = null;

  afterEach(async () => {
    if (broker) {
      await broker.shutdown();
      broker = null;
    }
  });

  it("start() binds an OS-assigned port and url reflects it", async () => {
    broker = createEgressBroker({
      policy: policyFromAllowlist(["api.anthropic.com"]),
    });
    expect(broker.port).toBe(0);
    expect(broker.url).toBe("");
    await broker.start();
    expect(broker.port).toBeGreaterThan(0);
    expect(broker.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("start() is idempotent", async () => {
    broker = createEgressBroker({
      policy: policyFromAllowlist(["api.anthropic.com"]),
    });
    await broker.start();
    const firstPort = broker.port;
    await broker.start();
    expect(broker.port).toBe(firstPort);
  });

  it("shutdown() is idempotent", async () => {
    broker = createEgressBroker({
      policy: policyFromAllowlist(["api.anthropic.com"]),
    });
    await broker.start();
    await broker.shutdown();
    await broker.shutdown();
    expect(broker.port).toBe(0);
  });
});

describe("createEgressBroker — HTTP (plaintext) request forwarding", () => {
  let broker: EgressBrokerHandle | null = null;
  let target: Awaited<ReturnType<typeof startLocalHttpTarget>> | null = null;

  beforeEach(async () => {
    target = await startLocalHttpTarget();
  });

  afterEach(async () => {
    if (broker) {
      await broker.shutdown();
      broker = null;
    }
    if (target) {
      await target.close();
      target = null;
    }
  });

  it("forwards allowed HTTP requests to the loopback origin", async () => {
    if (!target) throw new Error("target missing");
    broker = createEgressBroker({
      // `127.0.0.1` is a valid hostname under RFC 3986; our policy
      // validator treats numeric labels as valid DNS labels.
      policy: policyFromAllowlist(["127.0.0.1"]),
    });
    await broker.start();

    const allowed: PolicyEgressAllowedEvent[] = [];
    broker.on("policy.egress_allowed", (ev) => allowed.push(ev));

    const res = await requestViaProxy(broker, `http://127.0.0.1:${target.port}/hello`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("ok-target\n");
    expect(target.lastRequest().method).toBe("GET");
    expect(target.lastRequest().url).toBe("/hello");
    expect(allowed.length).toBe(1);
    expect(allowed[0]?.proxyMethod).toBe("HTTP");
    expect(allowed[0]?.host).toBe("127.0.0.1");
  });

  it("denies HTTP requests to hosts not in the allow-list (403 + event)", async () => {
    if (!target) throw new Error("target missing");
    broker = createEgressBroker({
      policy: policyFromAllowlist(["api.anthropic.com"]),
    });
    await broker.start();

    const denied: PolicyEgressDeniedEvent[] = [];
    broker.on("policy.egress_denied", (ev) => denied.push(ev));

    const res = await requestViaProxy(broker, `http://attacker.example:${target.port}/`);
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("egress denied");

    expect(denied.length).toBe(1);
    expect(denied[0]?.proxyMethod).toBe("HTTP");
    expect(denied[0]?.host).toBe("attacker.example");
    expect(denied[0]?.reason).toBe("host_not_allowlisted");
  });
});

describe("createEgressBroker — CONNECT tunnels (HTTPS path)", () => {
  let broker: EgressBrokerHandle | null = null;
  let echo: Awaited<ReturnType<typeof startEchoTcpTarget>> | null = null;

  beforeEach(async () => {
    echo = await startEchoTcpTarget();
  });

  afterEach(async () => {
    if (broker) {
      await broker.shutdown();
      broker = null;
    }
    if (echo) {
      await echo.close();
      echo = null;
    }
  });

  it("allowed CONNECT opens a transparent tunnel", async () => {
    if (!echo) throw new Error("echo missing");
    broker = createEgressBroker({
      policy: policyFromAllowlist(["127.0.0.1"]),
    });
    await broker.start();

    const allowed: PolicyEgressAllowedEvent[] = [];
    broker.on("policy.egress_allowed", (ev) => allowed.push(ev));

    const tunnel = await connectViaProxy(broker, `127.0.0.1:${echo.port}`);
    if (tunnel.kind !== "established") {
      throw new Error(`expected established tunnel; got ${tunnel.kind}`);
    }
    tunnel.write(Buffer.from("ping"));
    const received = await tunnel.read();
    expect(received.toString("utf8")).toBe("ping");
    tunnel.end();

    expect(allowed.length).toBe(1);
    expect(allowed[0]?.proxyMethod).toBe("CONNECT");
    expect(allowed[0]?.host).toBe("127.0.0.1");
  });

  it("denied CONNECT returns 403 + emits denied event", async () => {
    if (!echo) throw new Error("echo missing");
    broker = createEgressBroker({
      policy: policyFromAllowlist(["api.anthropic.com"]),
    });
    await broker.start();

    const denied: PolicyEgressDeniedEvent[] = [];
    broker.on("policy.egress_denied", (ev) => denied.push(ev));

    const result = await connectViaProxy(broker, `attacker.example:${echo.port}`);
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.statusCode).toBe(403);
    expect(result.body).toContain("egress denied");

    expect(denied.length).toBe(1);
    expect(denied[0]?.proxyMethod).toBe("CONNECT");
    expect(denied[0]?.host).toBe("attacker.example");
    expect(denied[0]?.port).toBe(echo.port);
    expect(denied[0]?.reason).toBe("host_not_allowlisted");
  });

  it("malformed CONNECT target is denied with invalid_target", async () => {
    broker = createEgressBroker({
      policy: policyFromAllowlist(["api.anthropic.com"]),
    });
    await broker.start();

    const denied: PolicyEgressDeniedEvent[] = [];
    broker.on("policy.egress_denied", (ev) => denied.push(ev));

    // `http.request({ method: 'CONNECT', path: 'no-port' })` emits
    // `CONNECT no-port`, which lacks the required host:port form.
    const result = await connectViaProxy(broker, "no-port");
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected") throw new Error("unreachable");
    expect(result.statusCode).toBe(403);
    expect(denied.length).toBe(1);
    expect(denied[0]?.reason).toBe("invalid_target");
  });
});

describe("createEgressBroker — event emitter semantics", () => {
  it("on() returns an unsubscribe that stops further events", async () => {
    const broker = createEgressBroker({
      policy: policyFromAllowlist(["api.anthropic.com"]),
    });
    await broker.start();
    try {
      const received: PolicyEgressDeniedEvent[] = [];
      const off = broker.on("policy.egress_denied", (ev) => received.push(ev));

      // Trigger one deny.
      await requestViaProxy(broker, "http://attacker.example/").catch(() => {
        // request layer may or may not throw on 403 body close; don't care.
      });
      expect(received.length).toBeGreaterThanOrEqual(1);
      const before = received.length;

      off();
      await requestViaProxy(broker, "http://attacker.example/").catch(() => {
        // ignore
      });
      // Count must not increase after unsubscribe.
      expect(received.length).toBe(before);
    } finally {
      await broker.shutdown();
    }
  });

  it("listener exceptions do not crash the broker", async () => {
    const broker = createEgressBroker({
      policy: policyFromAllowlist(["api.anthropic.com"]),
    });
    await broker.start();
    try {
      broker.on("policy.egress_denied", () => {
        throw new Error("listener boom");
      });
      const res = await requestViaProxy(broker, "http://attacker.example/");
      expect(res.statusCode).toBe(403);
    } finally {
      await broker.shutdown();
    }
  });
});
