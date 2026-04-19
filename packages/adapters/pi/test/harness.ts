/**
 * Shared test harness for the Pi adapter: a scripted `PiDriver` that
 * records every command invocation and lets each test push synthetic Pi
 * async events + protocol errors at will.
 *
 * No subprocess, no real binary. The contract suite uses a similar (but
 * larger) scripted double directly in `test/contract.test.ts`.
 */

import type { PiDriver } from "../src/driver.ts";
import type { PiProtocolError } from "../src/errors.ts";
import type { PiAsyncEvent, PiRpcClient } from "../src/rpc-client.ts";

export interface FakeDriverOverrides {
  /**
   * Override `sendCommand`. Receives the raw command name + params +
   * resolves with the payload that the handle sees.
   */
  readonly sendCommand?: (
    type: string,
    params: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
  /** Initial sessionId / sessionPath returned by `new_session`. */
  readonly initialSessionId?: string;
  /** Return value from `new_session`. Default `{ sessionId: initialSessionId }`. */
  readonly newSessionData?: unknown;
}

export interface FakeDriverHarness {
  readonly driver: PiDriver;
  /** Record of every command sent to the fake. */
  readonly calls: Array<{ type: string; params: Readonly<Record<string, unknown>> }>;
  /** Push an async event to every subscriber. */
  pushEvent(ev: PiAsyncEvent): void;
  /** Push a protocol error to every subscriber. */
  pushProtocolError(err: PiProtocolError): void;
  /** Was `driver.close()` ever called? */
  closed(): boolean;
  /** The current sessionId the fake committed to (updated on switch_session). */
  readonly sessionId: () => string;
}

export function makeFakeDriver(overrides: FakeDriverOverrides = {}): FakeDriverHarness {
  const calls: Array<{ type: string; params: Readonly<Record<string, unknown>> }> = [];
  const eventHandlers = new Set<(ev: PiAsyncEvent) => void>();
  const protocolErrorHandlers = new Set<(err: PiProtocolError) => void>();
  let isClosed = false;
  let currentSessionId = overrides.initialSessionId ?? "/tmp/pi-fake-session-1.jsonl";

  const client: PiRpcClient = {
    async sendCommand<T = unknown>(
      type: string,
      params: Readonly<Record<string, unknown>> = {},
    ): Promise<T> {
      calls.push({ type, params });
      if (overrides.sendCommand) {
        return (await overrides.sendCommand(type, params)) as T;
      }
      if (type === "new_session") {
        const data =
          overrides.newSessionData !== undefined
            ? overrides.newSessionData
            : { sessionId: currentSessionId };
        return data as T;
      }
      if (type === "switch_session") {
        const nextPath = params.sessionPath;
        if (typeof nextPath === "string" && nextPath.length > 0) {
          currentSessionId = nextPath;
        }
        return undefined as unknown as T;
      }
      // Default to an empty success payload.
      return undefined as unknown as T;
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
    },
    onProtocolError(handler) {
      protocolErrorHandlers.add(handler);
      return () => protocolErrorHandlers.delete(handler);
    },
    onReady() {
      // The fake never fires a ready frame — the driver's grace window
      // covers it in production; tests don't exercise the handshake path.
      return () => {};
    },
    async close() {
      isClosed = true;
    },
  };

  const driver: PiDriver = {
    client,
    async close() {
      isClosed = true;
    },
  };

  return {
    driver,
    calls,
    pushEvent(ev) {
      for (const h of eventHandlers) h(ev);
    },
    pushProtocolError(err) {
      for (const h of protocolErrorHandlers) h(err);
    },
    closed: () => isClosed,
    sessionId: () => currentSessionId,
  };
}
