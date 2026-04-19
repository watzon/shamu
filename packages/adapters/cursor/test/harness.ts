/**
 * Shared test harness: a scripted `CursorDriver` that records calls and lets
 * each test push synthetic `session/update` notifications + server-initiated
 * `session/request_permission` requests at will.
 */

import type {
  AcpClient,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpLoadSessionParams,
  AcpNewSessionParams,
  AcpNewSessionResult,
  AcpPermissionDecision,
  AcpPermissionRequest,
  AcpPromptParams,
  AcpPromptResult,
  AcpProtocolError,
  AcpSessionUpdate,
} from "@shamu/protocol-acp";
import type { CursorDriver } from "../src/driver.ts";

/** Overrides any or all client methods so tests can simulate failures. */
export interface FakeDriverOverrides {
  readonly initialize?: (params: AcpInitializeParams) => Promise<AcpInitializeResult>;
  readonly authenticate?: (method: string, params?: unknown) => Promise<unknown>;
  readonly newSession?: (params: AcpNewSessionParams) => Promise<AcpNewSessionResult>;
  readonly loadSession?: (params: AcpLoadSessionParams) => Promise<void>;
  readonly prompt?: (
    params: AcpPromptParams,
    opts?: { timeoutMs?: number },
  ) => Promise<AcpPromptResult>;
  readonly cancelSession?: (sessionId: string) => Promise<void>;
  /** Seed vendor sessionId. Default "sess-cursor-fake-1". */
  readonly initialSessionId?: string;
}

export interface FakeDriverHarness {
  readonly driver: CursorDriver;
  /** Record of every method invocation in order. */
  readonly calls: Array<{ method: string; args: unknown }>;
  /** Push a synthetic session/update to every subscriber. */
  pushSessionUpdate(ev: AcpSessionUpdate): void;
  /** Push a server-initiated permission request; returns the client's decision. */
  pushPermissionRequest(req: AcpPermissionRequest): Promise<AcpPermissionDecision>;
  /** Push a synthetic protocol error. */
  pushProtocolError(err: AcpProtocolError): void;
  /** Has the driver been closed? */
  closed(): boolean;
  /** The current sessionId the newSession call committed to. */
  readonly sessionId: () => string;
}

export function makeFakeDriver(overrides: FakeDriverOverrides = {}): FakeDriverHarness {
  const calls: Array<{ method: string; args: unknown }> = [];
  const sessionUpdates = new Set<(ev: AcpSessionUpdate) => void>();
  const protocolErrors = new Set<(err: AcpProtocolError) => void>();
  let permissionHandler: ((req: AcpPermissionRequest) => Promise<AcpPermissionDecision>) | null =
    null;
  let isClosed = false;
  let currentSessionId = overrides.initialSessionId ?? "sess-cursor-fake-1";

  const client: AcpClient = {
    async initialize(params) {
      calls.push({ method: "initialize", args: params });
      if (overrides.initialize) return overrides.initialize(params);
      return { protocolVersion: 1, agentInfo: { name: "cursor-fake" } };
    },
    async authenticate(method, params) {
      calls.push({ method: "authenticate", args: { method, params } });
      if (overrides.authenticate) return overrides.authenticate(method, params);
      return {};
    },
    async newSession(params) {
      calls.push({ method: "session/new", args: params });
      if (overrides.newSession) return overrides.newSession(params);
      return { sessionId: currentSessionId };
    },
    async loadSession(params) {
      calls.push({ method: "session/load", args: params });
      currentSessionId = params.sessionId;
      if (overrides.loadSession) return overrides.loadSession(params);
    },
    async prompt(params, opts) {
      calls.push({ method: "session/prompt", args: { params, opts } });
      if (overrides.prompt) return overrides.prompt(params, opts);
      return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 20 } };
    },
    async cancelSession(sessionId) {
      calls.push({ method: "session/cancel", args: { sessionId } });
      if (overrides.cancelSession) return overrides.cancelSession(sessionId);
    },
    onSessionUpdate(handler) {
      sessionUpdates.add(handler);
      return () => sessionUpdates.delete(handler);
    },
    onPermissionRequest(handler) {
      permissionHandler = handler;
      return () => {
        if (permissionHandler === handler) permissionHandler = null;
      };
    },
    onProtocolError(handler) {
      protocolErrors.add(handler);
      return () => protocolErrors.delete(handler);
    },
    onServerRequest() {
      return () => {};
    },
    async sendRequest<T = unknown>(): Promise<T> {
      throw new Error("sendRequest not supported in fake");
    },
    sendNotification() {
      // no-op
    },
    async close() {
      isClosed = true;
    },
  };

  const driver: CursorDriver = {
    client,
    async close() {
      isClosed = true;
    },
  };

  return {
    driver,
    calls,
    pushSessionUpdate(ev) {
      for (const h of sessionUpdates) h(ev);
    },
    async pushPermissionRequest(req) {
      if (!permissionHandler) {
        throw new Error("No permission handler registered on fake driver");
      }
      return permissionHandler(req);
    },
    pushProtocolError(err) {
      for (const h of protocolErrors) h(err);
    },
    closed: () => isClosed,
    sessionId: () => currentSessionId,
  };
}
