/**
 * End-to-end A2A demo.
 *
 * Boots the server from `server.ts`, drives it from `client.ts`, prints a
 * deterministic transcript, and exits 0 in < 5 seconds. No real vendor API
 * is called — the server's handler is a stub echo adapter.
 *
 * The two-phase boot (bind → shutdown → rebind with real URL in the card)
 * is the obvious way to publish an Agent Card that matches the bound port:
 * a real deployment would bind once and sign the card with a preconfigured
 * external URL. Keeping the self-contained shape here makes the demo
 * deterministic.
 */

import { buildDemoClient, generateClientKeys, runOneTask } from "./client.ts";
import { buildDemoCard, generateDemoKeys, startDemoServer, summarizeUpdates } from "./server.ts";

async function main(): Promise<void> {
  const started = Date.now();
  const serverKeys = await generateDemoKeys();
  const clientKeys = await generateClientKeys();

  // Phase 1 — bind to discover the port, shut down.
  const placeholderCard = await buildDemoCard(serverKeys, {
    http: "http://127.0.0.1/a2a",
    sse: "http://127.0.0.1/a2a/stream",
  });
  const warm = await startDemoServer({
    keys: serverKeys,
    card: placeholderCard,
    port: 0,
    issuerKeys: new Map([[clientKeys.did, clientKeys.jwk]]),
  });
  const boundPort = warm.port;
  await warm.shutdown();

  // Phase 2 — re-bind with a card whose endpoints point at the real URL.
  const realCard = await buildDemoCard(serverKeys, {
    http: `http://127.0.0.1:${boundPort}/a2a`,
    sse: `http://127.0.0.1:${boundPort}/a2a/stream`,
  });
  const server = await startDemoServer({
    keys: serverKeys,
    card: realCard,
    port: boundPort,
    issuerKeys: new Map([[clientKeys.did, clientKeys.jwk]]),
  });

  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  log("[a2a-demo] server listening");
  log(`[a2a-demo]   url: ${server.url}`);
  log(`[a2a-demo]   issuer: ${serverKeys.did}`);
  log(`[a2a-demo]   client: ${clientKeys.did}`);

  const client = await buildDemoClient(clientKeys, `${server.url}/.well-known/agent.json`);
  log("[a2a-demo] card fetched + verified");

  const transcript = await runOneTask(client, "demo-task-1", "hello remote claude");
  log("[a2a-demo] task transcript:");
  log(summarizeUpdates(transcript));

  await client.close();
  await server.shutdown();

  const elapsedMs = Date.now() - started;
  log(`[a2a-demo] done in ${elapsedMs}ms`);
}

main().catch((err: unknown) => {
  console.error("[a2a-demo] failed:", err);
  process.exit(1);
});
