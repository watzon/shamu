# shamu/egress-broker — container image

This directory contains the scaffolding for the `shamu/egress-broker` Docker
image that `@shamu/egress-broker-container` launches per run.

> This PR ships the recipe only. A separate release pipeline (out of scope
> for track 8.C.5) handles tagging + publishing to the container registry.

## Contents

- `Dockerfile` — two-stage build (`node:22-alpine` + `tsc` → runtime image).
- `proxy.ts` — the in-container HTTP(S) proxy. Mirrors
  `packages/egress-broker/src/broker.ts` minus the `Bun.spawn` bits; policy
  decisions are emitted as NDJSON on stdout. `matchHost` + `normalizeHost`
  are inlined with a "keep in sync" comment; the TypeScript parity test
  guards the host-side contract and the in-process broker's test suite
  validates `matchHost` itself.
- `tsconfig.json` — minimal build config so `tsc` in the build stage can
  produce `proxy.js`.

## Build

From the repo root:

```bash
docker build \
  -t shamu/egress-broker:0.1.0 \
  packages/egress-broker-container/docker/
```

Bump the tag whenever this directory's content changes; update
`SIDECAR_IMAGE_VERSION` in
`packages/egress-broker-container/src/types.ts` to match.

## Run (manual debugging)

The host-side broker (`createContainerEgressBroker`) drives `docker run`
directly. For local debugging without the host broker, start the image
against a hand-crafted policy:

```bash
cat > /tmp/policy.json <<'JSON'
{
  "defaultPolicy": "deny",
  "allowedHosts": ["api.anthropic.com"],
  "allowedHostSuffixes": []
}
JSON

docker run --rm -p 127.0.0.1:18080:8080 \
  -v /tmp/policy.json:/etc/shamu/policy.json:ro \
  shamu/egress-broker:0.1.0
```

Then from another terminal:

```bash
HTTPS_PROXY=http://127.0.0.1:18080 curl -v https://api.anthropic.com/ 2>&1 | head
# ...succeeds (CONNECT tunnel opens)

HTTPS_PROXY=http://127.0.0.1:18080 curl -v https://attacker.example/ 2>&1 | head
# ...fails with 403; see policy.egress_denied NDJSON on the container's stdout.
```

## Environment overrides

The entrypoint reads three optional env vars (defaults suit the host
broker's conventions; override only for local debugging):

- `SHAMU_POLICY_PATH` — JSON policy path. Default `/etc/shamu/policy.json`.
- `SHAMU_BIND_HOST` — bind host inside the container. Default `0.0.0.0`.
- `SHAMU_BIND_PORT` — bind port inside the container. Default `8080`.

## Log shape

Each decision emits one NDJSON line on stdout:

```json
{"type":"policy.egress_allowed","ts":1730000000000,"proxyMethod":"CONNECT","host":"api.anthropic.com","port":443,"clientAddr":"172.17.0.3:40000"}
{"type":"policy.egress_denied","ts":1730000000001,"proxyMethod":"HTTP","rawTarget":"http://attacker.example/","host":"attacker.example","port":80,"reason":"host_not_allowlisted"}
```

The host broker parses these and re-emits via the typed emitter —
`policy.egress_allowed` and `policy.egress_denied` have exactly the shape
used by the in-process broker.

## Sync discipline

`proxy.ts` intentionally inlines `matchHost` + `normalizeHost` from
`packages/egress-broker/src/policy.ts`. The container build is standalone
(no workspace link) and keeping the function small enough to copy avoids
the complexity of running a bun/pnpm install during `docker build`. When
you change `matchHost` in the in-process package, copy the change here and
bump `SIDECAR_IMAGE_VERSION`.
