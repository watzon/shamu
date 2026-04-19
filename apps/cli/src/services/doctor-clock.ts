/**
 * Helper for `shamu doctor`'s clock-skew check.
 *
 * Queries a public NTP server via a minimal in-process client (Node `dgram`),
 * parses the transmit timestamp out of the response, compares to the local
 * clock, and returns `pass` / `fail` / `todo`.
 *
 * Why our own NTP client?
 *   - No external dep. `ntp-client` / `node-ntp-client` are abandoned and
 *     the 48-byte client packet is trivial.
 *   - Our semantics are narrow: ask ONE server, ONCE, with a short timeout.
 *     Pool.ntp.org is load-balanced DNS; picking a fresh IP each time is
 *     fine for a health check (not for actual timekeeping).
 *
 * Thresholds (per PLAN.md G7 / webhook timestamp skew):
 *   - `pass` if |local - ntp| <= 5s
 *   - `fail` if |local - ntp| > 5s
 *
 * Escape hatches:
 *   - `$SHAMU_DOCTOR_NO_NTP=1` → `todo` "clock-skew check disabled"
 *   - query timeout (default 2s) → `todo` "unreachable" — common on offline
 *     dev machines, so not a hard fail.
 *
 * NTP v4 client packet (RFC 5905):
 *   byte 0     : LI (2) | VN (3) | Mode (3)   — 0b00_100_011 = 0x23
 *   bytes 1-47 : zeros (server fills stratum, poll, precision, etc.)
 *   Response bytes 40-47 : Transmit Timestamp (seconds+fraction, NTP epoch
 *     starting 1900-01-01 UTC). Convert to Unix ms by subtracting
 *     2208988800 s.
 */

import { createSocket } from "node:dgram";

export const DEFAULT_NTP_HOST = "pool.ntp.org";
export const DEFAULT_NTP_PORT = 123;
export const DEFAULT_NTP_TIMEOUT_MS = 2_000;
export const CLOCK_SKEW_THRESHOLD_MS = 5_000;

/** Seconds between the NTP epoch (1900-01-01) and the Unix epoch. */
const NTP_UNIX_OFFSET_SECONDS = 2_208_988_800;

/**
 * Thin seam for `ntpQuery`. The real implementation reaches UDP; tests use
 * injected fakes.
 */
export type NtpQueryFn = (
  host: string,
  port: number,
  timeoutMs: number,
) => Promise<
  { ok: true; ntpMs: number } | { ok: false; reason: "timeout" | "error"; error?: string }
>;

export interface ClockSkewCheckOptions {
  /** Override for `Date.now()` — used in tests. */
  readonly now?: () => number;
  /** Override the NTP probe — used in tests. */
  readonly ntpQuery?: NtpQueryFn;
  /** NTP host (default `pool.ntp.org`). */
  readonly host?: string;
  /** NTP port (default 123). */
  readonly port?: number;
  /** Per-request timeout (default 2s). */
  readonly timeoutMs?: number;
  /** Reader for the env-var escape hatch. Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface ClockSkewCheckResult {
  readonly status: "pass" | "fail" | "todo";
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Fire one NTP client packet at `host:port`; resolve with the parsed
 * transmit-timestamp (in Unix ms) or a typed failure. Socket is always
 * closed; never throws on network issues.
 */
export function ntpQuery(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<
  { ok: true; ntpMs: number } | { ok: false; reason: "timeout" | "error"; error?: string }
> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    let settled = false;
    const settle = (
      res: { ok: true; ntpMs: number } | { ok: false; reason: "timeout" | "error"; error?: string },
    ): void => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // already closed
      }
      clearTimeout(timer);
      resolve(res);
    };

    const timer = setTimeout(() => {
      settle({ ok: false, reason: "timeout" });
    }, timeoutMs);
    timer.unref?.();

    socket.on("error", (err) => {
      settle({ ok: false, reason: "error", error: err.message });
    });

    socket.on("message", (msg) => {
      if (msg.length < 48) {
        settle({ ok: false, reason: "error", error: `short NTP response (${msg.length}B)` });
        return;
      }
      const seconds = msg.readUInt32BE(40);
      const fraction = msg.readUInt32BE(44);
      if (seconds === 0) {
        settle({ ok: false, reason: "error", error: "server returned zero transmit timestamp" });
        return;
      }
      const unixSeconds = seconds - NTP_UNIX_OFFSET_SECONDS;
      const unixMs = unixSeconds * 1000 + Math.floor((fraction / 0x1_0000_0000) * 1000);
      settle({ ok: true, ntpMs: unixMs });
    });

    const packet = Buffer.alloc(48);
    // LI=0, VN=4, Mode=3 (client). 0b00_100_011 = 0x23.
    packet[0] = 0x23;
    try {
      socket.send(packet, 0, packet.length, port, host, (err) => {
        if (err) settle({ ok: false, reason: "error", error: err.message });
      });
    } catch (cause) {
      settle({
        ok: false,
        reason: "error",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  });
}

export async function clockSkewCheck(
  opts: ClockSkewCheckOptions = {},
): Promise<ClockSkewCheckResult> {
  const env = opts.env ?? process.env;
  if (env.SHAMU_DOCTOR_NO_NTP === "1") {
    return {
      status: "todo",
      ok: true,
      detail: "clock-skew check disabled (SHAMU_DOCTOR_NO_NTP=1)",
    };
  }

  const host = opts.host ?? DEFAULT_NTP_HOST;
  const port = opts.port ?? DEFAULT_NTP_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_NTP_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const query = opts.ntpQuery ?? ntpQuery;

  const localBefore = now();
  const result = await query(host, port, timeoutMs);
  const localAfter = now();
  // Use the midpoint of the local clock around the round-trip to slightly
  // reduce RTT bias. Not critical for a 5s threshold, but cheap.
  const localMid = Math.round((localBefore + localAfter) / 2);

  if (!result.ok) {
    if (result.reason === "timeout") {
      return {
        status: "todo",
        ok: true,
        detail: `NTP unreachable (${host}:${port} timed out after ${timeoutMs}ms) — offline? skipping`,
      };
    }
    const errDetail = result.error ? `: ${result.error}` : "";
    return {
      status: "todo",
      ok: true,
      detail: `NTP unreachable (${host}:${port}${errDetail}) — skipping`,
    };
  }

  const skewMs = Math.abs(localMid - result.ntpMs);
  const skewSec = Math.round(skewMs / 1000);
  if (skewMs <= CLOCK_SKEW_THRESHOLD_MS) {
    return {
      status: "pass",
      ok: true,
      detail: `skew=${skewSec}s (vs ${host})`,
    };
  }
  return {
    status: "fail",
    ok: false,
    detail: `skew=${skewSec}s (>5s — shamu signed commits + JWT bearers may be rejected)`,
  };
}
