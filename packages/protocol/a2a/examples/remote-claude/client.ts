/**
 * Example A2A client for the remote-claude demo.
 *
 * Handles keypair generation, client construction, and a one-shot
 * subscribe-until-terminal task that returns a transcript for the demo's
 * stdout.
 */

import type { A2aClient, AgentCardJwk, Message, TaskUpdateEvent } from "../../src/index.ts";
import { createA2aClient, deriveDidKeyFromJwk } from "../../src/index.ts";

export interface DemoClientKeys {
  readonly privateKey: CryptoKey;
  readonly jwk: AgentCardJwk;
  readonly did: string;
}

export async function generateClientKeys(): Promise<DemoClientKeys> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as { x: string };
  const jwk: AgentCardJwk = { kty: "OKP", crv: "Ed25519", x: exported.x };
  const did = await deriveDidKeyFromJwk(jwk);
  return { privateKey: kp.privateKey, jwk, did };
}

export async function buildDemoClient(keys: DemoClientKeys, cardUrl: string): Promise<A2aClient> {
  return createA2aClient({
    remoteCardUrl: cardUrl,
    issuerPrivateKey: keys.privateKey,
    issuerDid: keys.did,
  });
}

export async function runOneTask(
  client: A2aClient,
  taskId: string,
  prompt: string,
): Promise<TaskUpdateEvent[]> {
  const message: Message = {
    role: "user",
    parts: [{ kind: "text", text: prompt }],
  };
  const stream = await client.subscribeTask({ id: taskId, message });
  const collected: TaskUpdateEvent[] = [];
  for await (const ev of stream) {
    collected.push(ev);
    if (collected.length > 64) break; // defensive bound
  }
  return collected;
}
