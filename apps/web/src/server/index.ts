#!/usr/bin/env bun
/**
 * Shamu web dashboard — entry point.
 *
 * Boots the Hono app against the CLI's canonical SQLite database and serves
 * it on `127.0.0.1:<port>` via Bun's native `Bun.serve`. Single-user,
 * on-device; deliberately never binds to a non-loopback interface.
 *
 * Config (all env-driven; no flags in MVP):
 *   SHAMU_WEB_PORT    override the default 4711
 *   SHAMU_STATE_DIR   override the SQLite state dir (mirrors the CLI)
 */

import { openDatabase } from "@shamu/persistence";
import { createApp } from "./app.ts";
import { resolveConfig } from "./config.ts";

export async function main(): Promise<void> {
  const config = resolveConfig();
  const db = openDatabase(config.dbPath);
  const app = createApp({ db, config });

  const server = Bun.serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
    // SSE connections outlive a typical request; keep the handler awake.
    idleTimeout: 0,
  });

  process.stdout.write(
    `shamu web listening at http://${server.hostname}:${server.port}\n` +
      `  db:        ${config.dbPath}\n` +
      `  staticDir: ${config.staticDir}\n` +
      `  origins:   ${config.allowedOrigins.join(", ")}\n`,
  );

  // Graceful shutdown — close the DB handle and the server on SIGINT/SIGTERM.
  const shutdown = (signal: NodeJS.Signals) => {
    process.stdout.write(`\nreceived ${signal}; shutting down shamu web\n`);
    server.stop(true);
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only self-start when run as a script (i.e. `bun src/server/index.ts`).
// Allows `import { main } from "./server/index.ts"` in tests without
// double-booting.
const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  void main();
}
