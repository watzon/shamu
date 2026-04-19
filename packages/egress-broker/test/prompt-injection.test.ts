/**
 * Threat-model scenario from PLAN.md § Security (G2):
 *
 *   "Contract test: prompt injection attempting `curl attacker.com` is
 *    blocked and logged."
 *
 * We simulate the subprocess-with-HTTPS_PROXY path rather than spawning a
 * real `curl` — the test must run hermetically in `bun run test` and the
 * gate. The simulation uses Node's `http.request` with:
 *   - `HTTPS_PROXY` pointing at the broker
 *   - the CONNECT method (the exact verb `curl` emits for an HTTPS URL)
 * and asserts the broker rejects the target, emits the domain event, and
 * writes an audit entry when `egressLogPath` is configured.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createEgressBroker,
  type EgressBrokerHandle,
  loadEgressPolicy,
  type PolicyEgressDeniedEvent,
  policyFromAllowlist,
} from "../src/index.ts";

/**
 * Simulate `curl -x $HTTPS_PROXY https://<host>/` at the wire level.
 * Opens a raw TCP connection to the broker, writes a bare-metal CONNECT
 * request, and returns the parsed status + body. Raw-bytes vs Node's
 * high-level `http.request` CONNECT client — the former is simpler to
 * reason about when asserting the exact denial response shape.
 */
function simulateCurlHttpsThroughProxy(
  brokerPort: number,
  targetHost: string,
  targetPort = 443,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(brokerPort, "127.0.0.1");
    let settled = false;
    const settle = (v: { statusCode: number; body: string }): void => {
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
    let mode: "header" | "body" | "tunnel" = "header";
    const bodyChunks: Buffer[] = [];
    let rejectStatus = 0;

    const finalize = (): void => {
      if (mode === "body") {
        settle({
          statusCode: rejectStatus,
          body: Buffer.concat(bodyChunks).toString("utf8"),
        });
      }
    };
    sock.on("end", finalize);
    sock.on("close", finalize);

    sock.on("data", (chunk: Buffer) => {
      if (mode === "body") {
        bodyChunks.push(chunk);
        return;
      }
      if (mode === "tunnel") {
        return;
      }
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
        sock.destroy();
        if (!settled) {
          settled = true;
          reject(new Error("egress broker unexpectedly tunneled to attacker host"));
        }
        return;
      }
      mode = "body";
      rejectStatus = statusCode;
      if (rest.length > 0) bodyChunks.push(rest);
    });

    sock.once("connect", () => {
      sock.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`,
      );
    });
  });
}

describe("prompt-injection scenario: curl attacker.com is blocked", () => {
  let tmpDir: string | null = null;
  let broker: EgressBrokerHandle | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "shamu-egress-audit-"));
  });

  afterEach(async () => {
    if (broker) {
      await broker.shutdown();
      broker = null;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("denies attacker.com CONNECT under the Anthropic default allow-list", async () => {
    broker = createEgressBroker({
      policy: policyFromAllowlist(["api.anthropic.com"]),
    });
    await broker.start();

    const events: PolicyEgressDeniedEvent[] = [];
    broker.on("policy.egress_denied", (ev) => events.push(ev));

    const res = await simulateCurlHttpsThroughProxy(broker.port, "attacker.com");
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("egress denied");

    expect(events.length).toBe(1);
    const ev = events[0];
    if (!ev) throw new Error("missing deny event");
    expect(ev.proxyMethod).toBe("CONNECT");
    expect(ev.host).toBe("attacker.com");
    expect(ev.port).toBe(443);
    expect(ev.reason).toBe("host_not_allowlisted");
    // rawTarget carries the verbatim CONNECT target line — useful for audit.
    expect(ev.rawTarget).toBe("attacker.com:443");
  });

  it("still allows the sanctioned provider host under the same policy", async () => {
    broker = createEgressBroker({
      // `api.anthropic.com` can't be reached from the test environment, so
      // we use the loopback trick: the allow-list decides match; the tunnel
      // target is immaterial to the security decision. This test asserts
      // the *decision* (allow), not a live TLS handshake.
      policy: policyFromAllowlist(["127.0.0.1"]),
    });
    await broker.start();

    const denied: PolicyEgressDeniedEvent[] = [];
    broker.on("policy.egress_denied", (ev) => denied.push(ev));

    // We expect the CONNECT to reach the decision-point, be allowed, then
    // either establish a tunnel (to loopback port :1 which most systems
    // refuse) or the upstream dial errors out. Neither case should emit a
    // denied event.
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: "127.0.0.1",
        port: broker?.port ?? 0,
        method: "CONNECT",
        path: "127.0.0.1:1",
      });
      req.on("connect", (_res, socket) => {
        socket.destroy();
        resolve();
      });
      req.on("error", () => {
        // The upstream dial will almost certainly fail; the policy decision
        // already happened before the dial. What we're asserting here is
        // that NO denied event was emitted.
        resolve();
      });
      req.end();
    });

    expect(denied.length).toBe(0);
  });

  it("writes a JSONL audit entry per deny when egressLogPath is configured", async () => {
    if (!tmpDir) throw new Error("tmpDir missing");
    const auditPath = join(tmpDir, "audit.jsonl");
    const policy = loadEgressPolicy({
      defaultPolicy: "deny",
      allowedHosts: ["api.anthropic.com"],
      egressLogPath: auditPath,
    });
    broker = createEgressBroker({ policy });
    await broker.start();

    const seen: PolicyEgressDeniedEvent[] = [];
    broker.on("policy.egress_denied", (ev) => seen.push(ev));

    await simulateCurlHttpsThroughProxy(broker.port, "attacker.com");
    // Give the append a microtask-plus tick to flush; the broker writes
    // audit lines on a void-awaited promise.
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(seen.length).toBe(1);
    const text = readFileSync(auditPath, "utf8");
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const firstLine = lines[0];
    if (!firstLine) throw new Error("audit log missing line");
    const entry = JSON.parse(firstLine);
    expect(entry.type).toBe("policy.egress_denied");
    expect(entry.host).toBe("attacker.com");
    expect(entry.reason).toBe("host_not_allowlisted");
  });
});
