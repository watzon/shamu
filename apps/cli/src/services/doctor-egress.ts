/**
 * Helper for `shamu doctor`'s egress-broker reachability check.
 *
 * The broker is an in-process Node module (`@shamu/egress-broker`), so this
 * check doesn't need Docker or any external service. We spin up a short-lived
 * broker on a random loopback port with an empty allow-list, send a
 * deliberately-denied CONNECT, and assert the broker replies 403.
 *
 * This validates end-to-end that:
 *   1. The broker module loads in the current runtime.
 *   2. Node `http.createServer` can bind a loopback port.
 *   3. The deny path returns the documented 403 response (not a crash).
 *
 * Timeout: ≤ 2 seconds total. Broker is always shut down — errors are
 * swallowed so the doctor check never hangs.
 */

import { connect as netConnect, type Socket } from "node:net";
import { createEgressBroker, policyFromAllowlist } from "@shamu/egress-broker";

const CHECK_TIMEOUT_MS = 2_000;

export interface EgressBrokerCheckResult {
  readonly status: "pass" | "fail" | "todo";
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Open a raw TCP socket to the broker, send a CONNECT that must be denied,
 * read the first ~512 bytes back, and resolve with true iff the reply starts
 * with `HTTP/1.1 403`. Socket is always destroyed.
 */
function probeDeny(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let received = "";
    let sock: Socket | null = null;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.destroy();
      } catch {
        // ignore
      }
      resolve(ok);
    };

    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();

    try {
      sock = netConnect({ host: "127.0.0.1", port }, () => {
        // CONNECT to a host the empty allow-list cannot match.
        try {
          sock?.write(
            "CONNECT bogus.shamu.invalid:443 HTTP/1.1\r\nHost: bogus.shamu.invalid:443\r\n\r\n",
          );
        } catch {
          settle(false);
        }
      });
      sock.on("data", (chunk: Buffer) => {
        received += chunk.toString("utf8");
        // The broker writes the 403 + body and ends; check as soon as we see
        // the status line.
        if (received.includes("\r\n") || received.length > 512) {
          settle(/^HTTP\/1\.1 403\b/.test(received));
        }
      });
      sock.on("error", () => settle(false));
      sock.on("close", () => settle(/^HTTP\/1\.1 403\b/.test(received)));
    } catch {
      settle(false);
    }
  });
}

export async function egressBrokerCheck(
  opts: { timeoutMs?: number } = {},
): Promise<EgressBrokerCheckResult> {
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const policy = policyFromAllowlist([], []);
  const broker = createEgressBroker({ policy });

  try {
    await broker.start();
    const boundPort = broker.port;
    if (boundPort <= 0) {
      return {
        status: "fail",
        ok: false,
        detail: "broker start() returned without binding a port",
      };
    }

    const t0 = Date.now();
    const denied = await probeDeny(boundPort, timeoutMs);
    const elapsed = Date.now() - t0;
    if (!denied) {
      return {
        status: "fail",
        ok: false,
        detail: `broker did not reply 403 within ${timeoutMs}ms`,
      };
    }
    return {
      status: "pass",
      ok: true,
      detail: `denied CONNECT in ${elapsed}ms on 127.0.0.1:${boundPort}`,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      status: "fail",
      ok: false,
      detail: `broker check failed: ${message}`,
    };
  } finally {
    try {
      await broker.shutdown();
    } catch {
      // swallow — check already has its verdict.
    }
  }
}
