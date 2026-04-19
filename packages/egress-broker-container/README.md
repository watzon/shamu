# @shamu/egress-broker-container

Container-backed peer of [`@shamu/egress-broker`](../egress-broker). Provides
the same `EgressBrokerHandle` surface via a per-run Docker container that
hosts the policy-enforcing proxy.

## Why a second broker?

The in-process broker relies on the adapter subprocess honouring
`HTTPS_PROXY` / `HTTP_PROXY`. A misbehaving subprocess that ignores those
variables can reach arbitrary hosts. The container broker closes that
loophole with kernel-level isolation: the adapter runtime container attaches
to the proxy's Docker network with no default gateway, so the *only* route
out is through the proxy.

## Status

Opt-in. The in-process broker remains the default; callers that want hard
isolation call `createContainerEgressBroker(opts)` instead of
`createEgressBroker(opts)`. The composition helper
(`withEgressBroker` in `@shamu/core-composition`) still uses the in-process
broker by default; a follow-on cycle will add a `brokerFactory` knob so
`withEgressBroker({ brokerFactory: createContainerEgressBroker, ... })`
becomes the opt-in wire.

See `docs/phase-8/container-egress.md` for the end-to-end story.

## Usage

```ts
import { policyFromAllowlist } from "@shamu/egress-broker";
import { createContainerEgressBroker } from "@shamu/egress-broker-container";

const broker = createContainerEgressBroker({
  policy: policyFromAllowlist(["api.anthropic.com"]),
  // Optional overrides:
  // image: "shamu/egress-broker:0.1.0",
  // dockerPath: "docker",
  // networkName: "shamu-egress-net-run-123",
});

await broker.start();
// broker.url → http://127.0.0.1:<ephemeral-port>
// broker.containerId → <docker container id>
// broker.networkName → <network name used>

// ...point HTTPS_PROXY/HTTP_PROXY at broker.url for the adapter subprocess.

await broker.shutdown(); // idempotent
```

## Scope

**In scope (this PR):**

- `createContainerEgressBroker(opts)` with the same `EgressBrokerHandle`
  shape as the in-process broker.
- `containerEgressPreflight()` for `shamu doctor`-style readiness checks.
- Dockerfile + in-container proxy that speaks the same policy format and
  emits the same typed events as the in-process broker (via NDJSON on
  stdout; the host broker tails and re-emits).
- Unit tests that fully exercise the Docker lifecycle through a
  `DockerInvoker` seam — no live Docker daemon required.

**Out of scope:**

- Building and publishing the Docker image (release pipeline).
- Wiring the container backend into `withEgressBroker` (composition refactor
  next cycle).
- TLS interception / payload inspection (Phase 8 follow-on).
- Multi-run single-broker (per-connection policy tag).

## Design

See inline comments in `src/container.ts` for lifecycle details and
`docker/README.md` for the image recipe.
