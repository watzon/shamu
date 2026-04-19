/**
 * Unit tests for the Gemini driver layer. These DO NOT spawn a real
 * subprocess — we exercise the vendor-path resolver (including the new
 * `GEMINI_CLI_PATH` env + PATH-scan fallback), the auth precedence chain,
 * and the spawn-rollback contract via a stubbed transport factory.
 *
 * Live coverage (real `gemini --acp`) lives in `test/live/*.live.test.ts`
 * gated behind `SHAMU_GEMINI_LIVE=1`.
 */

import type { AcpClient } from "@shamu/protocol-acp";
import { describe, expect, it } from "vitest";
import { applyGeminiAuth, GeminiAuthError, resolveAuth } from "../src/auth.ts";
import { createRealGeminiDriver, resolveGeminiBinaryPath } from "../src/driver.ts";

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

describe("resolveGeminiBinaryPath", () => {
  it("prefers an explicit vendorCliPath when it exists", () => {
    const path = resolveGeminiBinaryPath({
      vendorCliPath: "/custom/gemini",
      existsImpl: (p) => p === "/custom/gemini",
      whichImpl: () => null,
    });
    expect(path).toBe("/custom/gemini");
  });

  it("throws when the explicit vendorCliPath is missing", () => {
    expect(() =>
      resolveGeminiBinaryPath({
        vendorCliPath: "/missing/gemini",
        existsImpl: () => false,
        whichImpl: () => null,
      }),
    ).toThrow(/not found/);
  });

  it("falls through to GEMINI_CLI_PATH env when vendorCliPath is unset", () => {
    const path = resolveGeminiBinaryPath({
      env: { GEMINI_CLI_PATH: "/env/gemini" },
      existsImpl: (p) => p === "/env/gemini",
      whichImpl: () => null,
    });
    expect(path).toBe("/env/gemini");
  });

  it("throws when GEMINI_CLI_PATH points at a missing file", () => {
    expect(() =>
      resolveGeminiBinaryPath({
        env: { GEMINI_CLI_PATH: "/env/nope" },
        existsImpl: () => false,
        whichImpl: () => null,
      }),
    ).toThrow(/GEMINI_CLI_PATH/);
  });

  it("falls through to which(gemini) when env is unset", () => {
    const path = resolveGeminiBinaryPath({
      env: {},
      existsImpl: (p) => p === "/usr/local/bin/gemini",
      whichImpl: (bin) => (bin === "gemini" ? "/usr/local/bin/gemini" : null),
    });
    expect(path).toBe("/usr/local/bin/gemini");
  });

  it("throws a helpful error when all fallbacks miss", () => {
    expect(() =>
      resolveGeminiBinaryPath({
        env: {},
        existsImpl: () => false,
        whichImpl: () => null,
      }),
    ).toThrow(/npm install -g @google\/gemini-cli/);
  });
});

describe("resolveAuth", () => {
  it("prefers vendorOpts.apiKey", () => {
    const r = resolveAuth({ apiKey: "k1" });
    expect(r?.source).toBe("vendorOpts.apiKey");
    expect(r?.params).toEqual({ apiKey: "k1" });
  });

  it("falls back to GEMINI_API_KEY env", () => {
    const gemini = process.env.GEMINI_API_KEY;
    const google = process.env.GOOGLE_AI_API_KEY;
    process.env.GEMINI_API_KEY = "env-gemini";
    delete process.env.GOOGLE_AI_API_KEY;
    try {
      const r = resolveAuth({});
      expect(r?.source).toBe("env:GEMINI_API_KEY");
      expect(r?.params).toEqual({ apiKey: "env-gemini" });
    } finally {
      if (gemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = gemini;
      if (google === undefined) delete process.env.GOOGLE_AI_API_KEY;
      else process.env.GOOGLE_AI_API_KEY = google;
    }
  });

  it("falls back to GOOGLE_AI_API_KEY env when GEMINI_API_KEY is unset", () => {
    const gemini = process.env.GEMINI_API_KEY;
    const google = process.env.GOOGLE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLE_AI_API_KEY = "env-google";
    try {
      const r = resolveAuth({});
      expect(r?.source).toBe("env:GOOGLE_AI_API_KEY");
      expect(r?.params).toEqual({ apiKey: "env-google" });
    } finally {
      if (gemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = gemini;
      if (google === undefined) delete process.env.GOOGLE_AI_API_KEY;
      else process.env.GOOGLE_AI_API_KEY = google;
    }
  });

  it("returns null when no material is present", () => {
    const g1 = process.env.GEMINI_API_KEY;
    const g2 = process.env.GOOGLE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    try {
      expect(resolveAuth({})).toBeNull();
    } finally {
      if (g1 !== undefined) process.env.GEMINI_API_KEY = g1;
      if (g2 !== undefined) process.env.GOOGLE_AI_API_KEY = g2;
    }
  });
});

describe("applyGeminiAuth", () => {
  it("dispatches authenticate('authenticate', { apiKey }) when apiKey is set", async () => {
    const capture: Array<{ method: string; params?: unknown }> = [];
    const client = fakeClient(capture);
    await applyGeminiAuth(client, { apiKey: "gapi-xyz" });
    expect(capture).toEqual([{ method: "authenticate", params: { apiKey: "gapi-xyz" } }]);
  });

  it("no-ops when no auth material is present (relies on `gemini /login`)", async () => {
    const g1 = process.env.GEMINI_API_KEY;
    const g2 = process.env.GOOGLE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    try {
      const capture: Array<{ method: string; params?: unknown }> = [];
      await applyGeminiAuth(fakeClient(capture), {});
      expect(capture).toHaveLength(0);
    } finally {
      if (g1 !== undefined) process.env.GEMINI_API_KEY = g1;
      if (g2 !== undefined) process.env.GOOGLE_AI_API_KEY = g2;
    }
  });

  it("wraps non-rpc errors as GeminiAuthError", async () => {
    const client = {
      ...fakeClient([]),
      authenticate: async () => {
        throw new Error("network dead");
      },
    } as AcpClient;
    await expect(applyGeminiAuth(client, { apiKey: "x" })).rejects.toBeInstanceOf(GeminiAuthError);
  });
});

describe("createRealGeminiDriver", () => {
  it("surfaces missing binary as SpawnError", async () => {
    await expect(
      createRealGeminiDriver({
        vendorCliPath: "/definitely/not/here",
      }),
    ).rejects.toThrow(/vendorCliPath/);
  });

  it("wires transportFactory through when provided (no real spawn)", async () => {
    // Use process.execPath — always exists on a dev machine.
    const driver = await createRealGeminiDriver({
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
    await driver.close();
    await driver.close(); // idempotent
  });
});
