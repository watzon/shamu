/**
 * Unit tests for the OpenCode driver layer. These deliberately DO NOT
 * invoke the real SDK — we exercise the driver's contract (close is
 * idempotent; auth registration surfaces SDK errors cleanly; the `attach`
 * branch does not spawn a server).
 *
 * Live-SDK coverage lives in `test/live/*.live.test.ts` gated by
 * `SHAMU_OPENCODE_LIVE=1`.
 */

import { describe, expect, it } from "vitest";
import { applyOpencodeAuth, OpencodeAuthError } from "../src/auth.ts";
import type { OpencodeSdkClient } from "../src/driver.ts";

function makeClient(overrides: Partial<OpencodeSdkClient> = {}): OpencodeSdkClient {
  return {
    session: {
      async create() {
        return { data: { id: "s" } };
      },
      async get(args) {
        return { data: { id: args.path.id } };
      },
      async prompt() {
        return { data: {} };
      },
      async abort() {
        return { data: true };
      },
      ...((overrides.session as Partial<OpencodeSdkClient["session"]>) ?? {}),
    } as OpencodeSdkClient["session"],
    event: {
      async subscribe() {
        return {
          stream: (async function* empty() {
            // empty
          })(),
        };
      },
      ...(overrides.event ?? {}),
    } as OpencodeSdkClient["event"],
    auth: {
      async set() {
        return { data: true };
      },
      ...(overrides.auth ?? {}),
    } as OpencodeSdkClient["auth"],
  };
}

describe("applyOpencodeAuth", () => {
  it("registers a provider api key", async () => {
    const calls: Array<{ id: string; key: string }> = [];
    const client = makeClient({
      auth: {
        async set(args) {
          calls.push({ id: args.path.id, key: args.body.key });
          return { data: true };
        },
      },
    });
    await applyOpencodeAuth(client, {
      providerId: "anthropic",
      apiKey: "sk-ant-fake-fixture-key-123",
    });
    expect(calls).toEqual([{ id: "anthropic", key: "sk-ant-fake-fixture-key-123" }]);
  });

  it("rejects empty providerId", async () => {
    const client = makeClient();
    await expect(applyOpencodeAuth(client, { providerId: "", apiKey: "x" })).rejects.toBeInstanceOf(
      OpencodeAuthError,
    );
  });

  it("rejects empty apiKey", async () => {
    const client = makeClient();
    await expect(
      applyOpencodeAuth(client, { providerId: "anthropic", apiKey: "" }),
    ).rejects.toBeInstanceOf(OpencodeAuthError);
  });

  it("wraps SDK errors as OpencodeAuthError", async () => {
    const client = makeClient({
      auth: {
        async set() {
          throw new Error("server rejected provider");
        },
      },
    });
    await expect(
      applyOpencodeAuth(client, { providerId: "anthropic", apiKey: "k" }),
    ).rejects.toBeInstanceOf(OpencodeAuthError);
  });

  it("surfaces non-true data as OpencodeAuthError", async () => {
    const client = makeClient({
      auth: {
        async set() {
          return { data: false };
        },
      },
    });
    await expect(
      applyOpencodeAuth(client, { providerId: "anthropic", apiKey: "k" }),
    ).rejects.toBeInstanceOf(OpencodeAuthError);
  });
});
