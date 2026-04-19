# A2A remote Claude — self-contained demo

Boots an A2A server (acting as a "remote Claude" adapter stub) and a client
in the same process, then runs a `tasks/sendSubscribe` flow end-to-end.

The server's `onTaskSubscribe` handler is a stub — it echoes the incoming
prompt back as a text artifact and marks the task `completed`. No real
Claude API is called.

## Run

```sh
bun examples/remote-claude/run-demo.ts
```

from this package root, or:

```sh
bun packages/protocol/a2a/examples/remote-claude/run-demo.ts
```

from the repo root. The demo exits 0 in under five seconds and prints a
deterministic sequence of events.

## Files

- `server.ts` — builds a signed Agent Card + starts an `@shamu/protocol-a2a`
  server with stub task handlers.
- `client.ts` — builds a client pointed at the server, sends a task,
  subscribes, and collects the event stream.
- `run-demo.ts` — boots both in-process, runs one task, prints the
  transcript, shuts both down.

## What it demonstrates

1. **Signed Agent Card publication.** The server signs its card with an
   Ed25519 private key + serves it at `/.well-known/agent.json`.
2. **Card verification on first contact.** The client fetches + verifies
   the card before sending any task.
3. **Bearer-token auth.** The client mints an Ed25519-signed JWS whose
   `iss` is its own `did:key`; the server verifies against its seeded
   issuer-key map.
4. **SSE streaming.** The server emits `working` → `artifact` → `completed`
   deltas; the client's `subscribeTask` returns an async iterable that
   terminates cleanly on the final status event.
