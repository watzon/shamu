# Container-based egress enforcement (Phase 8.C.5)

`@shamu/egress-broker-container` ships a Docker-backed peer of the
in-process broker (`@shamu/egress-broker`). Both surfaces expose the same
`EgressBrokerHandle` shape so a caller can swap backends at the factory
boundary.

## When to use it

Prefer the container broker when:

- The adapter subprocess cannot be trusted to honour `HTTPS_PROXY` — the
  in-process broker is *policy*, not enforcement, once the subprocess
  decides to bypass it.
- You're running in a production deployment where hard isolation (kernel
  network namespaces) is worth the Docker dependency.
- You want CI-visible audit trails: the container emits NDJSON decisions on
  stdout that the host broker re-emits as typed events, so
  `docker logs <id>` persists a raw decision log even if the host
  supervisor crashes.

The in-process broker remains the right default for dev + tests + any
environment where Docker isn't available.

## Opt-in

At the call site (supervisor-adjacent composition; *not* the default
`withEgressBroker` path, see limits below):

```ts
import { policyFromAllowlist } from "@shamu/egress-broker";
import { createContainerEgressBroker } from "@shamu/egress-broker-container";

const broker = createContainerEgressBroker({
  policy: policyFromAllowlist(["api.anthropic.com"]),
});

await broker.start();
const spawnEnv = {
  HTTPS_PROXY: broker.url,
  HTTP_PROXY: broker.url,
  NO_PROXY: "127.0.0.1,localhost",
};

try {
  // ...spawn the adapter subprocess with `env: spawnEnv`, drain to
  // completion.
} finally {
  await broker.shutdown();
}
```

Future wiring (not in this PR): `withEgressBroker` in
`@shamu/core-composition` will accept an injected factory so the choice
between in-process and container becomes a single-line change at the
composition boundary:

```ts
// proposed (next cycle)
await withEgressBroker({
  brokerFactory: createContainerEgressBroker,
  policy,
  baseSpawnOpts,
});
```

## Preflight check

Before opting a run into the container broker, callers can gate on
`containerEgressPreflight()`:

```ts
import { containerEgressPreflight } from "@shamu/egress-broker-container";

const result = await containerEgressPreflight();
if (!result.ok) {
  console.warn(`container egress not ready: ${result.reason} — ${result.detail}`);
  // fall back to the in-process broker for this run.
}
```

`shamu doctor` integrates this under track 8.C.1.

## How isolation works

1. The host broker calls `docker network create <per-run-name>` and
   `docker run --network <name> shamu/egress-broker:<version>`.
2. The proxy container binds `127.0.0.1:<ephemeral>:8080` on the host (so
   `broker.url` is a loopback URL the host supervisor can reach).
3. The adapter runtime (a sibling container, handled by separate
   composition plumbing) attaches to the same network *without a default
   gateway*. The only route off the network is through the proxy's internal
   address.
4. The proxy applies the `EgressPolicy` on every CONNECT and absolute-URI
   HTTP request; denied destinations get 403 + NDJSON decision line on
   stdout.
5. The host broker tails `docker logs --follow` and re-emits each NDJSON
   line as `policy.egress_allowed` / `policy.egress_denied` on the typed
   emitter — identical to the in-process broker's event shape.

## Limits

- **Docker dependency.** Without a reachable daemon, `start()` throws
  `DockerUnreachableError` up front. Callers that can't depend on Docker
  stay on the in-process broker.
- **Image availability.** The release pipeline (out of scope for this PR)
  publishes `shamu/egress-broker:<version>`; for local dev, build via
  `packages/egress-broker-container/docker/README.md`. `start()` surfaces
  `ContainerStartError` if the image is missing.
- **Same policy format.** The proxy reads the exact JSON shape
  `@shamu/egress-broker`'s `loadEgressPolicy` consumes. Host-side and
  container-side `matchHost` are kept in sync by hand (see
  `docker/proxy.ts`'s "keep in sync" comment); parity is enforced by
  `test/parity.test.ts` on the handle surface.
- **No TLS interception yet.** The proxy is host-level enforcement only —
  the CONNECT tunnel is opaque by design. Per-run CA + subprocess trust-
  store wiring for payload inspection is Phase 8 follow-on work.
- **Wiring gap.** `withEgressBroker` doesn't yet accept a brokerFactory;
  until it does, consumers that want container enforcement call
  `createContainerEgressBroker` directly (see example above).

## Test coverage

- `packages/egress-broker-container/test/container.test.ts` — full
  lifecycle assertions via the `DockerInvoker` + `DockerLogStreamer`
  seams. No real Docker involvement.
- `packages/egress-broker-container/test/preflight.test.ts` — each preflight
  reason path (`docker_unreachable`, `image_missing`, `stale_containers`,
  `network_error`).
- `packages/egress-broker-container/test/parity.test.ts` — TS-level
  assignment + runtime reflection proving
  `ContainerEgressBrokerHandle extends EgressBrokerHandle` without drift.
