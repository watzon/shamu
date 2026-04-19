# shamu/egress-broker — containerized peer of @shamu/egress-broker.
#
# This image runs the HTTP(S) policy-enforcing proxy inside a dedicated
# network namespace. The host mounts an EgressPolicy JSON at
# /etc/shamu/policy.json (read-only). The proxy listens on 8080 (inside the
# container) and emits NDJSON decision lines to stdout, which the host-side
# broker tails via `docker logs --follow`.
#
# Build:
#
#   docker build -t shamu/egress-broker:0.1.0 packages/egress-broker-container/docker/
#
# Run (for local debugging without the host broker):
#
#   docker run --rm -p 127.0.0.1:18080:8080 \
#     -v $(pwd)/policy.json:/etc/shamu/policy.json:ro \
#     shamu/egress-broker:0.1.0
#
# Then:
#
#   HTTPS_PROXY=http://127.0.0.1:18080 curl -v https://api.anthropic.com/...
#
# The release pipeline (out of scope for this PR) publishes this image; for
# now, this Dockerfile is the authoritative recipe. Bump the tag in
# packages/egress-broker-container/src/types.ts (SIDECAR_IMAGE_VERSION) when
# the content changes.

FROM node:22-alpine AS build

WORKDIR /opt/shamu-egress

# Copy the proxy source (TypeScript). We compile to JS so the runtime image
# doesn't need tsc; the compiled artefact is the entrypoint.
COPY proxy.ts ./proxy.ts
COPY tsconfig.json ./tsconfig.json

# Install a minimal toolchain just for compilation, then discard it in the
# final stage. Pinning matches the root monorepo's typescript version.
RUN npm install --no-audit --no-fund --no-package-lock typescript@6.0.3 \
    && ./node_modules/.bin/tsc --project tsconfig.json

FROM node:22-alpine AS runtime

WORKDIR /opt/shamu-egress

# Copy only the compiled JS from the build stage.
COPY --from=build /opt/shamu-egress/proxy.js ./proxy.js

# The policy is mounted read-only by the host.
RUN mkdir -p /etc/shamu

# Non-root user for the proxy. We don't need any host integration beyond
# reading the policy file; a nobody user is sufficient.
USER node

# Expose the canonical proxy port (the host publishes to an ephemeral port).
EXPOSE 8080

ENV NODE_NO_WARNINGS=1

CMD ["node", "/opt/shamu-egress/proxy.js"]
