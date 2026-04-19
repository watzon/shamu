/**
 * `@shamu/egress-broker` — public surface.
 *
 * Loadbearing exports:
 *
 *  - `createEgressBroker` — spawn a policy-enforcing HTTP(S) proxy on
 *    loopback. Agent subprocesses point `HTTPS_PROXY` / `HTTP_PROXY` at it.
 *  - `EgressPolicy` types + `loadEgressPolicy` / `policyFromAllowlist` —
 *    validate + construct policies.
 *  - `DEFAULT_ALLOWLISTS` — per-vendor defaults so callers without a
 *    persisted policy can still wire up a safe broker.
 *  - `PolicyEgressDeniedEvent` + `PolicyEgressAllowedEvent` — plain
 *    interfaces for the domain events surfaced on the broker handle. Not
 *    (yet) plumbed into `@shamu/core-supervisor`'s escalation bus; that's a
 *    follow-on track.
 *
 * See `docs/phase-7/` for the overall Phase 7 adapter / enforcement plan.
 * This package intentionally depends only on `@shamu/shared` and Node core.
 */

export { DEFAULT_ALLOWLISTS, type VendorAllowlist } from "./allowlists.ts";
export { createEgressBroker } from "./broker.ts";
export {
  loadEgressPolicy,
  loadEgressPolicyFromFile,
  matchHost,
  normalizeHost,
  policyFromAllowlist,
} from "./policy.ts";
export {
  EgressBrokerError,
  type EgressBrokerHandle,
  type EgressBrokerOptions,
  type EgressDenyReason,
  type EgressEventListener,
  type EgressEventMap,
  type EgressPolicy,
  EgressPolicyViolation,
  type PolicyEgressAllowedEvent,
  type PolicyEgressDeniedEvent,
  type VendorId,
} from "./types.ts";
