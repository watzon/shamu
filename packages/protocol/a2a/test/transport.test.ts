/**
 * Transport tests: server + client against a real loopback HTTP port.
 *
 * Covered scenarios:
 *   - `sendTask` one-shot round-trip, caller DID threaded through to handler
 *   - `cancelTask` + `getTask` dispatch
 *   - Concurrent `sendTask` don't collide (each response correlates to its request id)
 *   - Missing bearer → 401 with `missing-token`
 *   - Forged bearer (signed with wrong key) → 401 with `bad-token`
 *   - Tampered remote card → client construction rejects with verification error
 *   - `tasks/pushNotification/set` round-trips the config
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deriveDidKeyFromJwk, signAgentCard } from "../src/cards.ts";
import { A2aAuthError, A2aError } from "../src/errors.ts";
import {
  type A2aClient,
  type A2aServerHandle,
  createA2aClient,
  createA2aServer,
} from "../src/transport.ts";
import type { AgentCard, AgentCardJwk, Task, TaskSendParams } from "../src/types.ts";

async function mintKeypair(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: AgentCardJwk;
  did: string;
}> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as { x: string };
  const jwk: AgentCardJwk = { kty: "OKP", crv: "Ed25519", x: raw.x };
  const did = await deriveDidKeyFromJwk(jwk);
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, jwk, did };
}

interface ServerHarness {
  server: A2aServerHandle;
  card: AgentCard;
  serverKeys: Awaited<ReturnType<typeof mintKeypair>>;
}

const defaultHandlers = (opts: {
  onTaskSend?: (p: TaskSendParams, ctx: { callerDid: string }) => Promise<Task>;
}) => ({
  onTaskSend:
    opts.onTaskSend ??
    (async (p: TaskSendParams): Promise<Task> => ({
      id: p.id,
      status: { state: "completed" as const },
      artifacts: [
        {
          artifactId: "a1",
          parts: [{ kind: "text" as const, text: `echoed: ${p.id}` }],
        },
      ],
    })),
  onTaskSubscribe: async (
    params: TaskSendParams,
    _ctx: { callerDid: string },
    emit: (ev: import("../src/types.ts").TaskUpdateEvent) => void,
  ) => {
    emit({
      kind: "status-update",
      taskId: params.id,
      status: { state: "working" },
      final: false,
    });
    emit({
      kind: "artifact-update",
      taskId: params.id,
      artifact: {
        artifactId: "a1",
        parts: [{ kind: "text", text: `echoed: ${params.id}` }],
      },
      lastChunk: true,
    });
    emit({
      kind: "status-update",
      taskId: params.id,
      status: { state: "completed" },
      final: true,
    });
  },
  onTaskCancel: async (params: { id: string }): Promise<Task> => ({
    id: params.id,
    status: { state: "canceled" as const },
  }),
  onTaskGet: async (params: { id: string }): Promise<Task> => ({
    id: params.id,
    status: { state: "working" as const },
  }),
  onTaskPushNotificationSet: async <T>(params: T): Promise<T> => params,
});

async function makeServer(opts: {
  onTaskSend?: (p: TaskSendParams, ctx: { callerDid: string }) => Promise<Task>;
  trustedIssuers?: ReadonlySet<string>;
  issuerKeys?: ReadonlyMap<string, AgentCardJwk>;
}): Promise<ServerHarness> {
  const keys = await mintKeypair();
  const placeholderBody: Omit<AgentCard, "signature"> = {
    issuerDid: keys.did,
    subject: keys.did,
    name: "test-server",
    version: "0.0.1",
    capabilities: {
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: false,
    },
    skills: [{ id: "echo", name: "Echo" }],
    endpoints: { http: "http://placeholder/a2a" },
    signingKeyJwk: keys.jwk,
  };
  const placeholder = await signAgentCard({ body: placeholderBody, privateKey: keys.privateKey });

  // Boot to discover the bound port, then shut down and re-boot with a
  // card whose endpoints point at the real URL. Cheap on loopback.
  const handlers = defaultHandlers(opts);
  const warm = await createA2aServer({
    host: "127.0.0.1",
    port: 0,
    agentCard: placeholder,
    privateKey: keys.privateKey,
    ...(opts.trustedIssuers !== undefined ? { trustedIssuers: opts.trustedIssuers } : {}),
    ...(opts.issuerKeys !== undefined ? { issuerKeys: opts.issuerKeys } : {}),
    ...handlers,
  });
  const boundPort = warm.port;
  await warm.shutdown();

  const realCardBody: Omit<AgentCard, "signature"> = {
    ...placeholderBody,
    endpoints: {
      http: `http://127.0.0.1:${boundPort}/a2a`,
      sse: `http://127.0.0.1:${boundPort}/a2a/stream`,
    },
  };
  const realCard = await signAgentCard({ body: realCardBody, privateKey: keys.privateKey });
  const final = await createA2aServer({
    host: "127.0.0.1",
    port: boundPort,
    agentCard: realCard,
    privateKey: keys.privateKey,
    ...(opts.trustedIssuers !== undefined ? { trustedIssuers: opts.trustedIssuers } : {}),
    ...(opts.issuerKeys !== undefined ? { issuerKeys: opts.issuerKeys } : {}),
    ...handlers,
  });

  return { server: final, card: realCard, serverKeys: keys };
}

describe("A2A transport — happy paths", () => {
  let harness: ServerHarness;
  let client: A2aClient;
  let clientKeys: Awaited<ReturnType<typeof mintKeypair>>;

  beforeEach(async () => {
    clientKeys = await mintKeypair();
    harness = await makeServer({
      issuerKeys: new Map([[clientKeys.did, clientKeys.jwk]]),
    });
    client = await createA2aClient({
      remoteCardUrl: `${harness.server.url}/.well-known/agent.json`,
      issuerPrivateKey: clientKeys.privateKey,
      issuerDid: clientKeys.did,
    });
  });

  afterEach(async () => {
    await client.close();
    await harness.server.shutdown();
  });

  it("sends a task and receives a completed Task", async () => {
    const task = await client.sendTask({
      id: "t-happy-1",
      message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
    });
    expect(task.id).toBe("t-happy-1");
    expect(task.status.state).toBe("completed");
    expect(task.artifacts?.[0]?.parts?.[0]).toMatchObject({ kind: "text", text: /echoed/ });
  });

  it("threads caller DID through to the handler context", async () => {
    const seen: string[] = [];
    await harness.server.shutdown();
    harness = await makeServer({
      issuerKeys: new Map([[clientKeys.did, clientKeys.jwk]]),
      onTaskSend: async (params, ctx) => {
        seen.push(ctx.callerDid);
        return { id: params.id, status: { state: "completed" } };
      },
    });
    client = await createA2aClient({
      remoteCardUrl: `${harness.server.url}/.well-known/agent.json`,
      issuerPrivateKey: clientKeys.privateKey,
      issuerDid: clientKeys.did,
    });
    await client.sendTask({
      id: "t-ctx-1",
      message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
    });
    expect(seen).toEqual([clientKeys.did]);
  });

  it("cancels a task", async () => {
    const task = await client.cancelTask({ id: "t-cancel" });
    expect(task.status.state).toBe("canceled");
  });

  it("gets a task", async () => {
    const task = await client.getTask({ id: "t-get" });
    expect(task.status.state).toBe("working");
  });

  it("sets a push notification config", async () => {
    const params = {
      id: "t-push",
      pushNotificationConfig: { url: "https://example.test/push" },
    };
    const result = await client.setPushNotification(params);
    expect(result.pushNotificationConfig.url).toBe("https://example.test/push");
  });

  it("handles concurrent tasks without collision", async () => {
    const ids = ["c1", "c2", "c3", "c4", "c5"];
    const tasks = await Promise.all(
      ids.map((id) =>
        client.sendTask({
          id,
          message: { role: "user", parts: [{ kind: "text", text: id }] },
        }),
      ),
    );
    expect(tasks.map((t) => t.id).sort()).toEqual(ids);
    for (const t of tasks) {
      expect(t.status.state).toBe("completed");
    }
  });
});

describe("A2A transport — auth failures", () => {
  let harness: ServerHarness;

  afterEach(async () => {
    await harness?.server.shutdown();
  });

  it("rejects a POST with no Authorization header", async () => {
    harness = await makeServer({});
    const url = `${harness.server.url}/a2a`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x" } }),
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { reason: string } };
    expect(json.error.reason).toBe("missing-token");
  });

  it("rejects a forged bearer whose signature doesn't match the claimed issuer", async () => {
    const clientKeys = await mintKeypair();
    const attackerKeys = await mintKeypair();
    harness = await makeServer({
      // Seed the *legit* client's key; but we'll sign with the attacker's.
      issuerKeys: new Map([[clientKeys.did, clientKeys.jwk]]),
    });
    const { signJws } = await import("../src/jws.ts");
    const forged = await signJws({
      header: { alg: "EdDSA", typ: "JWT" },
      claims: {
        iss: clientKeys.did, // claim the legit DID…
        aud: harness.card.issuerDid,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      privateKey: attackerKeys.privateKey, // …but sign with the attacker's key
    });
    const res = await fetch(`${harness.server.url}/a2a`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${forged}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/get",
        params: { id: "x" },
      }),
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { reason: string } };
    expect(json.error.reason).toBe("bad-token");
  });

  it("rejects a bearer whose issuer isn't in the server's trust map", async () => {
    const clientKeys = await mintKeypair();
    harness = await makeServer({ issuerKeys: new Map() });
    const client = createA2aClient({
      remoteCardUrl: `${harness.server.url}/.well-known/agent.json`,
      issuerPrivateKey: clientKeys.privateKey,
      issuerDid: clientKeys.did,
    });
    const c = await client;
    await expect(
      c.sendTask({
        id: "untrusted",
        message: { role: "user", parts: [{ kind: "text", text: "x" }] },
      }),
    ).rejects.toBeInstanceOf(A2aAuthError);
    await c.close();
  });
});

describe("A2A transport — card verification", () => {
  it("rejects client construction when the served card has a tampered signature", async () => {
    const serverKeys = await mintKeypair();
    const clientKeys = await mintKeypair();
    const body = {
      issuerDid: serverKeys.did,
      subject: serverKeys.did,
      name: "test-server",
      version: "0.0.1",
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      skills: [{ id: "echo", name: "Echo" }],
      endpoints: { http: "http://127.0.0.1/a2a" },
      signingKeyJwk: serverKeys.jwk,
    };
    const good = await signAgentCard({ body, privateKey: serverKeys.privateKey });
    const tampered: AgentCard = { ...good, name: "not-the-server" };

    // Inject a fake fetcher that serves the tampered card.
    const fakeFetch = async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(tampered), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    await expect(
      createA2aClient({
        remoteCardUrl: "http://127.0.0.1/.well-known/agent.json",
        issuerPrivateKey: clientKeys.privateKey,
        issuerDid: clientKeys.did,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toBeInstanceOf(A2aError);
  });
});
