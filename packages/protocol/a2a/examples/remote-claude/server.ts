/**
 * Example A2A server — acts as a stub "remote Claude" adapter.
 *
 * Real adapter wiring (spawning the vendor CLI, projecting session updates,
 * managing tool calls) is out of scope for this protocol package; here the
 * handler echoes the first prompt part back as an artifact and terminates.
 *
 * The exported helpers (`startDemoServer`, `buildDemoCard`) let `run-demo.ts`
 * drive the whole thing end-to-end from a single process.
 */

import type {
  A2aServerHandle,
  AgentCard,
  AgentCardJwk,
  Part,
  Task,
  TaskSendParams,
  TaskUpdateEvent,
} from "../../src/index.ts";
import { createA2aServer, deriveDidKeyFromJwk, signAgentCard } from "../../src/index.ts";

export interface DemoServerKeys {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly jwk: AgentCardJwk;
  readonly did: string;
}

export async function generateDemoKeys(): Promise<DemoServerKeys> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as { x: string };
  const jwk: AgentCardJwk = { kty: "OKP", crv: "Ed25519", x: exported.x };
  const did = await deriveDidKeyFromJwk(jwk);
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, jwk, did };
}

export async function buildDemoCard(
  keys: DemoServerKeys,
  endpoints: { http: string; sse: string },
): Promise<AgentCard> {
  const body: Omit<AgentCard, "signature"> = {
    issuerDid: keys.did,
    subject: keys.did,
    name: "remote-claude-demo",
    description: "Stub A2A server demonstrating Shamu's protocol package.",
    version: "0.0.1",
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills: [
      {
        id: "echo-prompt",
        name: "Echo prompt",
        description: "Echoes the caller's prompt back as a text artifact.",
      },
    ],
    endpoints,
    signingKeyJwk: keys.jwk,
  };
  return signAgentCard({ body, privateKey: keys.privateKey });
}

export interface StartDemoServerOptions {
  readonly keys: DemoServerKeys;
  readonly card: AgentCard;
  readonly port: number;
  readonly issuerKeys: ReadonlyMap<string, AgentCardJwk>;
}

export async function startDemoServer(opts: StartDemoServerOptions): Promise<A2aServerHandle> {
  return createA2aServer({
    host: "127.0.0.1",
    port: opts.port,
    agentCard: opts.card,
    privateKey: opts.keys.privateKey,
    issuerKeys: opts.issuerKeys,
    onTaskSend: async (params) => buildEchoTask(params),
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
          artifactId: `${params.id}-echo`,
          name: "echo",
          parts: [{ kind: "text", text: echoText(params) }],
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
    onTaskCancel: async (params) => ({
      id: params.id,
      status: { state: "canceled" },
    }),
    onTaskGet: async (params) => ({
      id: params.id,
      status: { state: "working" },
    }),
    onTaskPushNotificationSet: async (params) => params,
  });
}

function buildEchoTask(params: TaskSendParams): Task {
  return {
    id: params.id,
    status: { state: "completed" },
    artifacts: [
      {
        artifactId: `${params.id}-echo`,
        name: "echo",
        parts: [{ kind: "text", text: echoText(params) }],
      },
    ],
  };
}

function echoText(params: TaskSendParams): string {
  const first = params.message.parts.find((p: Part) => p.kind === "text");
  const text = first && first.kind === "text" ? first.text : "(no text part)";
  return `remote-claude-demo received: ${text}`;
}

/**
 * Advances a readonly record of `TaskUpdateEvent`s to a printable summary
 * useful for the demo's stdout.
 */
export function summarizeUpdates(events: ReadonlyArray<TaskUpdateEvent>): string {
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.kind === "status-update") {
      lines.push(`  status=${ev.status.state} final=${ev.final}`);
    } else {
      const partSummary = ev.artifact.parts
        .map((p) => (p.kind === "text" ? `text:${p.text}` : p.kind))
        .join(",");
      lines.push(`  artifact=${ev.artifact.artifactId} (${partSummary})`);
    }
  }
  return lines.join("\n");
}
