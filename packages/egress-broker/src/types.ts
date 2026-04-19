/**
 * Public types for `@shamu/egress-broker`.
 *
 * The broker is a local HTTP(S) proxy shamu spawns per run. Agent
 * subprocesses point their `HTTPS_PROXY` / `HTTP_PROXY` env at it; all
 * outbound traffic flows through and is gated by an `EgressPolicy`.
 *
 * Denied destinations surface as `PolicyEgressDeniedEvent` domain events on
 * the broker handle's typed emitter. The shape is intentionally plain (no
 * `@shamu/core-supervisor` dependency) so Phase 8's containerized enforcement
 * can emit the same event shape from a different enforcer.
 *
 * See PLAN.md § "Security & threat model" (G2) for the broader context.
 */

import { ShamuError } from "@shamu/shared/errors";

/**
 * Vendor identifier for the default allow-list lookup. Matches the vendor
 * column on `AgentAdapter`. Keep in sync with `DEFAULT_ALLOWLISTS`.
 */
export type VendorId = "anthropic" | "openai" | "cursor" | "gemini" | "amp" | "pi" | "opencode";

/**
 * Policy shape persisted to disk (JSON) or constructed in-memory.
 *
 * Default-deny semantics: a request is allowed iff its host matches one of
 * `allowedHosts` (exact match) or `allowedHostSuffixes` (suffix match with
 * dot-boundary). The `defaultPolicy` field is informational today — the only
 * supported value is `"deny"` (any other value is rejected at load time) —
 * but we include it in the JSON shape so Phase 8's enforcement can evolve
 * from allow-list to full label-based policies without a schema break.
 *
 * Matching rules:
 * - Host comparison is case-insensitive and trailing-dot-insensitive
 *   (`API.Anthropic.Com.` === `api.anthropic.com`).
 * - `allowedHostSuffixes` entries MUST start with a `.` (e.g. `.fireworks.ai`
 *   matches `api.fireworks.ai` but NOT `evilfireworks.ai`). Entries that
 *   don't start with `.` are rejected at load time.
 * - Port is ignored; the policy governs which host a run can reach, not
 *   which port. Add per-port controls when a concrete threat model needs it.
 */
export interface EgressPolicy {
  readonly defaultPolicy: "deny";
  readonly allowedHosts: readonly string[];
  readonly allowedHostSuffixes: readonly string[];
  /**
   * Optional append-only JSONL path for an audit log. Every allow + deny
   * decision is written as one line (`{ ts, outcome, host, ... }`). When
   * absent, no file is written; callers rely on the emitter + logger.
   */
  readonly egressLogPath?: string;
}

/**
 * Constructor input for `createEgressBroker`. The policy is frozen on
 * construction; swap brokers rather than mutating.
 */
export interface EgressBrokerOptions {
  readonly policy: EgressPolicy;
  /** Bind host. Default `127.0.0.1`; non-loopback binds require explicit opt-in. */
  readonly host?: string;
  /** Bind port. Default `0` (OS-assigned). */
  readonly port?: number;
  /** Override the clock for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Why a request was denied. Preserved so dashboards can tell operators
 * apart "never in the allow-list" from "policy rejected this method".
 */
export type EgressDenyReason = "host_not_allowlisted" | "invalid_target" | "method_rejected";

/**
 * Domain event emitted when the broker refuses a request. Not integrated
 * with `@shamu/core-supervisor`'s escalation bus in this PR — that's a
 * followup track. The shape is a pure interface so a different enforcer
 * (Phase 8 container) can produce identical events.
 */
export interface PolicyEgressDeniedEvent {
  readonly type: "policy.egress_denied";
  readonly ts: number;
  /**
   * The proxy method that triggered the block. `CONNECT` = HTTPS tunnel
   * attempt; `HTTP` = plaintext request through the proxy.
   */
  readonly proxyMethod: "CONNECT" | "HTTP";
  /** The raw target the client asked for (verbatim — useful for audit). */
  readonly rawTarget: string;
  /** The host extracted from `rawTarget`. Empty string if unparseable. */
  readonly host: string;
  /** Port if the client specified one; `null` otherwise. */
  readonly port: number | null;
  readonly reason: EgressDenyReason;
  /** Optional remote-address tag for correlation with subprocess identity. */
  readonly clientAddr?: string;
}

/**
 * Allow event — mirrors the deny event for completeness and gives the audit
 * log a uniform shape. Not required by G2 but useful for Phase 8 analytics.
 */
export interface PolicyEgressAllowedEvent {
  readonly type: "policy.egress_allowed";
  readonly ts: number;
  readonly proxyMethod: "CONNECT" | "HTTP";
  readonly host: string;
  readonly port: number | null;
  readonly clientAddr?: string;
}

/** Base error class for the broker. Never thrown across the proxy boundary. */
export class EgressBrokerError extends ShamuError {
  public readonly code = "egress_broker_error" as const;
}

/** Thrown when a policy file or in-memory policy fails validation. */
export class EgressPolicyViolation extends ShamuError {
  public readonly code = "egress_policy_violation" as const;
}

/**
 * Typed emitter surface exposed on the broker handle. Kept intentionally
 * small so we don't need to depend on Node's `EventEmitter` type shape.
 */
export type EgressEventMap = {
  "policy.egress_denied": PolicyEgressDeniedEvent;
  "policy.egress_allowed": PolicyEgressAllowedEvent;
};

export type EgressEventListener<K extends keyof EgressEventMap> = (
  event: EgressEventMap[K],
) => void;

/**
 * Handle returned from `createEgressBroker`. The caller is responsible for
 * invoking `start()` before pointing agents at `url`, and `shutdown()` when
 * the run ends (or in an error path). Both are idempotent.
 */
export interface EgressBrokerHandle {
  /** Start listening. Resolves once the port is bound. Idempotent. */
  start(): Promise<void>;
  /** Shut down the listener and terminate in-flight tunnels. Idempotent. */
  shutdown(): Promise<void>;
  /** Bound port. `0` until `start()` resolves. */
  readonly port: number;
  /** Proxy URL suitable for `HTTPS_PROXY` / `HTTP_PROXY`. Empty until started. */
  readonly url: string;
  /** Subscribe to a broker event. Returns an unsubscribe function. */
  on<K extends keyof EgressEventMap>(type: K, listener: EgressEventListener<K>): () => void;
  /** Immutable copy of the policy this handle was constructed with. */
  readonly policy: EgressPolicy;
}
