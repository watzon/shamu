/**
 * Full A2A integration: server + client in one process, exercising the
 * `tasks/sendSubscribe` SSE flow end-to-end.
 *
 * - spin up a loopback server
 * - subscribe from the client
 * - collect the stream until the terminal `final: true` event
 * - assert we see working → artifact → completed in order
 * - total under 500ms
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveDidKeyFromJwk, signAgentCard } from "../src/cards.ts";
import {
  type A2aClient,
  type A2aServerHandle,
  createA2aClient,
  createA2aServer,
} from "../src/transport.ts";
import type { AgentCard, AgentCardJwk, TaskUpdateEvent } from "../src/types.ts";

interface Keypair {
  readonly privateKey: CryptoKey;
  readonly jwk: AgentCardJwk;
  readonly did: string;
}

async function mintKeypair(): Promise<Keypair> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as { x: string };
  const jwk: AgentCardJwk = { kty: "OKP", crv: "Ed25519", x: raw.x };
  const did = await deriveDidKeyFromJwk(jwk);
  return { privateKey: kp.privateKey, jwk, did };
}

async function buildCard(
  keys: Keypair,
  endpoints: { http: string; sse: string },
): Promise<AgentCard> {
  const body: Omit<AgentCard, "signature"> = {
    issuerDid: keys.did,
    subject: keys.did,
    name: "integration-agent",
    version: "0.0.1",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills: [{ id: "echo", name: "Echo" }],
    endpoints,
    signingKeyJwk: keys.jwk,
  };
  return signAgentCard({ body, privateKey: keys.privateKey });
}

describe("A2A integration — tasks/sendSubscribe SSE flow", () => {
  let serverHandle: A2aServerHandle;
  let client: A2aClient;
  let clientKeys: Keypair;
  let serverKeys: Keypair;

  beforeAll(async () => {
    serverKeys = await mintKeypair();
    clientKeys = await mintKeypair();

    // Two-phase startup so the served card advertises the real bound URL.
    const placeholder = await buildCard(serverKeys, {
      http: "http://127.0.0.1/a2a",
      sse: "http://127.0.0.1/a2a/stream",
    });
    const warm = await createA2aServer({
      host: "127.0.0.1",
      port: 0,
      agentCard: placeholder,
      privateKey: serverKeys.privateKey,
      issuerKeys: new Map([[clientKeys.did, clientKeys.jwk]]),
      onTaskSend: async (params) => ({ id: params.id, status: { state: "completed" } }),
      onTaskSubscribe: async (params, _ctx, emit) => {
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
    });
    const boundPort = warm.port;
    await warm.shutdown();

    const realCard = await buildCard(serverKeys, {
      http: `http://127.0.0.1:${boundPort}/a2a`,
      sse: `http://127.0.0.1:${boundPort}/a2a/stream`,
    });
    serverHandle = await createA2aServer({
      host: "127.0.0.1",
      port: boundPort,
      agentCard: realCard,
      privateKey: serverKeys.privateKey,
      issuerKeys: new Map([[clientKeys.did, clientKeys.jwk]]),
      onTaskSend: async (params) => ({ id: params.id, status: { state: "completed" } }),
      onTaskSubscribe: async (params, _ctx, emit) => {
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
    });

    client = await createA2aClient({
      remoteCardUrl: `${serverHandle.url}/.well-known/agent.json`,
      issuerPrivateKey: clientKeys.privateKey,
      issuerDid: clientKeys.did,
    });
  });

  afterAll(async () => {
    await client?.close();
    await serverHandle?.shutdown();
  });

  it("streams working → artifact → completed and terminates cleanly", async () => {
    const start = Date.now();
    const stream = await client.subscribeTask({
      id: "int-1",
      message: { role: "user", parts: [{ kind: "text", text: "integration" }] },
    });
    const collected: TaskUpdateEvent[] = [];
    for await (const ev of stream) {
      collected.push(ev);
      // Defense in depth: the stream terminates on its own, but never run away.
      if (collected.length > 50) break;
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);

    expect(collected.length).toBe(3);
    expect(collected[0]?.kind).toBe("status-update");
    if (collected[0]?.kind === "status-update") {
      expect(collected[0].status.state).toBe("working");
      expect(collected[0].final).toBe(false);
    }
    expect(collected[1]?.kind).toBe("artifact-update");
    if (collected[1]?.kind === "artifact-update") {
      expect(collected[1].artifact.parts[0]).toMatchObject({ kind: "text", text: /echoed: int-1/ });
    }
    expect(collected[2]?.kind).toBe("status-update");
    if (collected[2]?.kind === "status-update") {
      expect(collected[2].status.state).toBe("completed");
      expect(collected[2].final).toBe(true);
    }
  });

  it("emits typed task-lifecycle events on the server handle", async () => {
    const events: string[] = [];
    const offStart = serverHandle.on("task-start", (ev) => {
      events.push(`start:${ev.taskId}:${ev.streaming}`);
    });
    const offUpdate = serverHandle.on("task-update", (ev) => {
      events.push(`update:${ev.taskId}:${ev.event.kind}`);
    });
    const offEnd = serverHandle.on("task-end", (ev) => {
      events.push(`end:${ev.taskId}:${ev.reason}`);
    });
    try {
      const stream = await client.subscribeTask({
        id: "int-events",
        message: { role: "user", parts: [{ kind: "text", text: "events" }] },
      });
      for await (const _ev of stream) {
        // drain
      }
    } finally {
      offStart();
      offUpdate();
      offEnd();
    }
    expect(events).toContain("start:int-events:true");
    expect(events.filter((e) => e.startsWith("update:int-events"))).toHaveLength(3);
    expect(events.some((e) => e.startsWith("end:int-events"))).toBe(true);
  });
});
