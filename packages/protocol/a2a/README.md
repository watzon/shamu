# `@shamu/protocol-a2a`

Shamu's Agent-to-Agent (A2A) v1.0 server + client library. Self-contained:
no dependency on the supervisor, mailbox, or any adapter. The supervisor
integration — adding a remote A2A agent as a first-class participant in a
swarm — is a follow-on Phase 8 track.

## Scope (v1)

- **Signed Agent Cards** (Ed25519). A card is a JSON document describing the
  agent's capabilities, skills, and endpoints, plus a base64url Ed25519
  signature over its canonical-JSON form. The issuer DID is derived from the
  signing key's JWK via `did:key` (`0xed01` multicodec for Ed25519).
- **JSON-RPC 2.0 method set:** `tasks/send`, `tasks/sendSubscribe`,
  `tasks/get`, `tasks/cancel`, `tasks/pushNotification/set`.
- **HTTP transport:** POST `/a2a` for one-shot requests; POST `/a2a/stream`
  (or POST `/a2a` with `Accept: text/event-stream`) for SSE streaming.
- **Bearer-token auth:** every POST carries `Authorization: Bearer <jws>`.
  The JWS uses `alg: "EdDSA"` and its `iss` claim identifies the caller's
  DID. The server verifies the JWS against the issuer's cached public key.
- **TOFU trust (optional allow-list):** `verifyAgentCard` accepts a
  `trustedIssuers` set so a deployment can restrict which DIDs it trusts.
  Without one, any cryptographically valid card is accepted.
- **`/.well-known/agent.json`** serves the signed Agent Card.
- **No external crypto deps.** All signing / verification goes through
  Node + Bun's native `crypto.subtle` Ed25519; base58btc / JWS serialization
  is in-package.

## Non-scope (v1)

- **Supervisor / mailbox integration.** This package doesn't know about
  swarms or runs. Wiring a remote agent into a Shamu swarm happens in a
  later track.
- **Push notifications transport.** `tasks/pushNotification/set` stores the
  caller's config but no outbound push is implemented; deferred to the
  supervisor track that needs it.
- **Multi-issuer trust store persistence.** The server holds its issuer
  trust map in memory. Persistence across restarts is a follow-on concern.
- **Content negotiation beyond the two modes above.** No gRPC transport,
  no WebSocket, no MIME variants.

## Example

A self-contained demo lives at [`examples/remote-claude/`](./examples/remote-claude).
It boots an in-process A2A server that echoes the incoming prompt as an
artifact, then runs a client that subscribes to the task and prints the
stream. Run it with:

```sh
bun examples/remote-claude/run-demo.ts
```

From this package root, or from the repo root:

```sh
bun packages/protocol/a2a/examples/remote-claude/run-demo.ts
```

The demo prints deterministic output and exits 0 in under five seconds.

## Tests

- `test/cards.test.ts` — sign / verify round-trip, tamper detection,
  key-DID mismatch, allow-list rejection.
- `test/transport.test.ts` — one-shot RPC round-trip, bad-bearer rejection,
  tampered-card rejection at card-fetch time, concurrent tasks.
- `test/integration.test.ts` — full `sendSubscribe` SSE flow end-to-end in
  one process.

Run with `bun run test` from the repo root or `vitest run` from this
package.
