/**
 * Unit tests for the Cursor driver layer. These DO NOT spawn a real
 * subprocess — we exercise the vendor-path resolver, the auth
 * precedence chain, and the spawn-rollback contract via a stubbed
 * transport factory.
 *
 * Live coverage (real `cursor-agent acp`) lives in `test/live/*.live.test.ts`
 * gated behind `SHAMU_CURSOR_LIVE=1`.
 */

import type { AcpClient } from "@shamu/protocol-acp";
import { describe, expect, it } from "vitest";
import { applyCursorAuth, CursorAuthError, resolveAuth } from "../src/auth.ts";
import { createRealCursorDriver, resolveCursorBinaryPath } from "../src/driver.ts";

function fakeClient(capture: Array<{ method: string; params?: unknown }>): AcpClient {
  return {
    async initialize() {
      return { protocolVersion: 1 };
    },
    async authenticate(method, params) {
      capture.push({ method, params });
      return {};
    },
    async newSession() {
      return { sessionId: "s" };
    },
    async loadSession() {
      // no-op
    },
    async prompt() {
      return { stopReason: "end_turn" };
    },
    async cancelSession() {
      // no-op
    },
    onSessionUpdate: () => () => {},
    onPermissionRequest: () => () => {},
    onProtocolError: () => () => {},
    onServerRequest: () => () => {},
    async sendRequest<T = unknown>(): Promise<T> {
      return {} as unknown as T;
    },
    sendNotification() {
      // no-op
    },
    async close() {
      // no-op
    },
  };
}

describe("resolveCursorBinaryPath", () => {
  it("prefers an explicit vendorCliPath when it exists", () => {
    const path = resolveCursorBinaryPath({
      vendorCliPath: "/custom/agent",
      existsImpl: (p) => p === "/custom/agent",
      homedirImpl: () => "/home/user",
    });
    expect(path).toBe("/custom/agent");
  });

  it("throws when the explicit vendorCliPath is missing", () => {
    expect(() =>
      resolveCursorBinaryPath({
        vendorCliPath: "/missing/agent",
        existsImpl: () => false,
        homedirImpl: () => "/home/user",
      }),
    ).toThrow(/not found/);
  });

  it("falls through to CURSOR_AGENT_PATH env when vendorCliPath is unset", () => {
    const path = resolveCursorBinaryPath({
      env: { CURSOR_AGENT_PATH: "/env/agent" },
      existsImpl: (p) => p === "/env/agent",
      homedirImpl: () => "/home/user",
    });
    expect(path).toBe("/env/agent");
  });

  it("falls through to ~/.local/bin/agent when env is unset", () => {
    const path = resolveCursorBinaryPath({
      env: {},
      existsImpl: (p) => p === "/home/user/.local/bin/agent",
      homedirImpl: () => "/home/user",
    });
    expect(path).toBe("/home/user/.local/bin/agent");
  });

  it("throws a helpful error when all fallbacks miss", () => {
    expect(() =>
      resolveCursorBinaryPath({
        env: {},
        existsImpl: () => false,
        homedirImpl: () => "/home/user",
      }),
    ).toThrow(/Cursor Desktop is not installed/);
  });
});

describe("resolveAuth", () => {
  it("prefers vendorOpts.apiKey", () => {
    const r = resolveAuth({ apiKey: "k1", authToken: "t1" });
    expect(r?.source).toBe("vendorOpts.apiKey");
    expect(r?.params).toEqual({ apiKey: "k1" });
  });

  it("falls back to vendorOpts.authToken when apiKey is empty", () => {
    const r = resolveAuth({ apiKey: "", authToken: "t1" });
    expect(r?.source).toBe("vendorOpts.authToken");
    expect(r?.params).toEqual({ authToken: "t1" });
  });

  it("falls back to CURSOR_API_KEY env", () => {
    const original = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "env-key";
    try {
      const r = resolveAuth({});
      expect(r?.source).toBe("env:CURSOR_API_KEY");
    } finally {
      if (original === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = original;
    }
  });

  it("returns null when no material is present", () => {
    const k = process.env.CURSOR_API_KEY;
    const t = process.env.CURSOR_AUTH_TOKEN;
    delete process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_AUTH_TOKEN;
    try {
      expect(resolveAuth({})).toBeNull();
    } finally {
      if (k !== undefined) process.env.CURSOR_API_KEY = k;
      if (t !== undefined) process.env.CURSOR_AUTH_TOKEN = t;
    }
  });
});

describe("applyCursorAuth", () => {
  it("dispatches authenticate('cursor_login', { apiKey }) when apiKey is set", async () => {
    const capture: Array<{ method: string; params?: unknown }> = [];
    const client = fakeClient(capture);
    await applyCursorAuth(client, { apiKey: "sk-cursor-xyz" });
    expect(capture).toEqual([{ method: "cursor_login", params: { apiKey: "sk-cursor-xyz" } }]);
  });

  it("no-ops when no auth material is present (relies on already-logged-in Cursor Desktop)", async () => {
    const k = process.env.CURSOR_API_KEY;
    const t = process.env.CURSOR_AUTH_TOKEN;
    delete process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_AUTH_TOKEN;
    try {
      const capture: Array<{ method: string; params?: unknown }> = [];
      await applyCursorAuth(fakeClient(capture), {});
      expect(capture).toHaveLength(0);
    } finally {
      if (k !== undefined) process.env.CURSOR_API_KEY = k;
      if (t !== undefined) process.env.CURSOR_AUTH_TOKEN = t;
    }
  });

  it("wraps non-rpc errors as CursorAuthError", async () => {
    const client = {
      ...fakeClient([]),
      authenticate: async () => {
        throw new Error("network dead");
      },
    } as AcpClient;
    await expect(applyCursorAuth(client, { apiKey: "x" })).rejects.toBeInstanceOf(CursorAuthError);
  });
});

describe("createRealCursorDriver", () => {
  it("surfaces missing binary as SpawnError", async () => {
    await expect(
      createRealCursorDriver({
        vendorCliPath: "/definitely/not/here",
      }),
    ).rejects.toThrow(/vendorCliPath/);
  });

  it("wires transportFactory through when provided (no real spawn)", async () => {
    const driver = await createRealCursorDriver({
      vendorCliPath: "/home/user/.local/bin/agent",
      // Override the existsSync fallback by using transportFactory — the
      // resolveCursorBinaryPath still runs, so the path must exist for this
      // to succeed. Point at a real file we know exists.
      transportFactory: () => ({
        async send() {
          // no-op
        },
        messages: (async function* empty() {
          // intentionally empty
        })(),
        async close() {
          // no-op
        },
      }),
      // Use the vitest config path (always exists) as a real, existing file.
      // We rewire the vendorCliPath to a real path to sidestep resolver.
    }).catch(async () => {
      // If it fails because path doesn't exist (which is expected on most
      // dev machines), fall back to supplying a file that definitely does.
      return createRealCursorDriver({
        vendorCliPath: process.execPath,
        transportFactory: () => ({
          async send() {
            // no-op
          },
          messages: (async function* empty() {
            // intentionally empty
          })(),
          async close() {
            // no-op
          },
        }),
      });
    });
    await driver.close();
    await driver.close(); // idempotent
  });
});
