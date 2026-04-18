/**
 * Shared types for `@shamu/linear-integration`.
 *
 * The four canonical Phase 6 labels are named here as a frozen constant so
 * every primitive in this package references the same string, and typos
 * surface at type-check time instead of at runtime against Linear. The
 * escalation template table lives here too — it's data, not behaviour, and
 * keeping it adjacent to the label constants makes the sink's cause → comment
 * mapping easy to audit in one place.
 *
 * We intentionally do NOT re-export `LinearError`, `RunId`, etc. from this
 * module — consumers pull those from their home packages. This file only
 * owns shapes unique to the integration layer.
 */

import type { EscalationCause } from "@shamu/core-supervisor/events";
import type { RunId } from "@shamu/shared/ids";

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * The four canonical Phase 6 labels. Values are the string names Linear uses;
 * the keys are the short handles that flow through the codebase. The `as const`
 * preserves the literal types so `ShamuLabelName` is a precise string union
 * (not just `string`), which lets the label-state machine narrow exhaustively.
 */
export const SHAMU_LABELS = {
  ready: "shamu:ready",
  inProgress: "shamu:in-progress",
  review: "shamu:review",
  blocked: "shamu:blocked",
} as const;

export type ShamuLabelName = (typeof SHAMU_LABELS)[keyof typeof SHAMU_LABELS];

/** Convenience: the full set of managed label names, used for "preserve non-shamu labels" logic. */
export const SHAMU_LABEL_NAMES: ReadonlySet<ShamuLabelName> = new Set<ShamuLabelName>([
  SHAMU_LABELS.ready,
  SHAMU_LABELS.inProgress,
  SHAMU_LABELS.review,
  SHAMU_LABELS.blocked,
]);

// ---------------------------------------------------------------------------
// Pickup event
// ---------------------------------------------------------------------------

/**
 * Emitted by the pickup driver each time a `shamu:ready` webhook fires. The
 * driver mints the `runId` itself (via `newRunId`) and binds it to the issue
 * in the registry before invoking the consumer's `onPickup` callback.
 */
export interface LinearPickup {
  readonly kind: "linear.pickup";
  readonly issueId: string;
  /** The shamu-local run id minted for this pickup. */
  readonly runId: RunId;
  /** Wall-clock ms when the pickup happened. */
  readonly at: number;
}

// ---------------------------------------------------------------------------
// Checkpoint payload
// ---------------------------------------------------------------------------

/**
 * A single progress update appended to a rolling comment. `detail` is
 * rendered as a markdown blockquote when present.
 */
export interface Checkpoint {
  readonly at: number;
  readonly headline: string;
  readonly detail?: string;
}

// ---------------------------------------------------------------------------
// Escalation templates
// ---------------------------------------------------------------------------

/**
 * Template applied to a single `EscalationCause` variant. The sink picks a
 * template by matching `cause` exactly; when a new cause is added to the
 * supervisor union, append a template here rather than modifying the sink.
 */
export interface EscalationTemplate {
  readonly cause: EscalationCause;
  readonly headline: string;
  readonly bodyPrefix: string;
}

/**
 * Default cause → template mapping. The order matches the supervisor's
 * declaration order in `@shamu/core-supervisor/events` for readability; the
 * sink looks up by `cause` equality so ordering is not load-bearing.
 *
 * Keep headlines short (single line) — they render as the `##` heading in the
 * escalation comment. Body prefixes end with a period; the sink appends a
 * blockquote with the supervisor's human-readable `reason` on the next line.
 */
export const DEFAULT_ESCALATION_TEMPLATES: readonly EscalationTemplate[] = [
  {
    cause: "ci_tripwire",
    headline: "CI red-streak tripwire",
    bodyPrefix: "Consecutive CI failures tripped the role-scoped watchdog.",
  },
  {
    cause: "watchdog_agreement",
    headline: "Watchdog agreement",
    bodyPrefix: "Two watchdog signals agreed for this run.",
  },
  {
    cause: "lease_reclaim_refused",
    headline: "Stale-lease reclaim refused",
    bodyPrefix: "The mailbox refused a lease reclaim.",
  },
  {
    cause: "intensity_exceeded",
    headline: "Restart budget exceeded",
    bodyPrefix: "The supervisor exhausted its restart budget for this role.",
  },
  {
    cause: "start_failed",
    headline: "Child start failed",
    bodyPrefix: "A child failed to start.",
  },
  {
    cause: "policy_violation",
    headline: "Policy violation",
    bodyPrefix: "A layered orchestrator reported a policy violation.",
  },
] as const;
