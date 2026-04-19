/**
 * `@shamu/egress-broker-container` — public surface.
 *
 * Drop-in peer of `@shamu/egress-broker`. Exposes the same
 * `EgressBrokerHandle` shape, but the enforcement proxy lives inside a
 * per-run Docker container, giving hard network isolation: the adapter
 * subprocess's container is attached to the same Docker network with no
 * default gateway, so the proxy is the *only* route to the outside world.
 *
 * Opt-in: call `createContainerEgressBroker()` instead of
 * `createEgressBroker()`. The `EgressPolicy` format is identical.
 *
 * See `docs/phase-8/container-egress.md` for the end-to-end usage story
 * and known limits (Docker dependency, no TLS interception yet).
 */

export { createContainerEgressBroker } from "./container.ts";
export { containerEgressPreflight } from "./preflight.ts";
export {
  type ContainerEgressBrokerHandle,
  type ContainerEgressBrokerOptions,
  type ContainerEgressPreflightResult,
  ContainerLogParseError,
  ContainerShutdownError,
  ContainerStartError,
  DEFAULT_CONTAINER_POLICY_PATH,
  DEFAULT_CONTAINER_PROXY_PORT,
  DEFAULT_SIDECAR_IMAGE,
  type DockerInvoker,
  type DockerLogStreamer,
  DockerUnreachableError,
  type PolicyEgressAllowedEvent,
  type PolicyEgressDeniedEvent,
  SIDECAR_IMAGE_VERSION,
} from "./types.ts";
