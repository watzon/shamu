/**
 * `@shamu/linear-integration` — public surface.
 *
 * Phase 6.C.2 orchestration primitives composed over `@shamu/linear-client`
 * and `@shamu/linear-webhook`:
 *
 *   - `createLabelStateMachine` — idempotent `shamu:ready → in-progress →
 *     review → blocked` label transitions.
 *   - `createRollingComment` — one comment per run, edited in place per
 *     checkpoint, finalized with a summary.
 *   - `attachPrToIssue` — round-trip a PR URL as a Linear attachment.
 *   - `createRunIssueRegistry` — in-memory bidirectional map binding
 *     `RunId` ⟷ `issueId`.
 *   - `createPickupDriver` — drains the webhook async iterator and emits
 *     `LinearPickup` events on `shamu:ready` label-adds.
 *   - `createEscalationSink` — subscribes to an `EventBus<SupervisorEvent>`,
 *     filters `escalation_raised`, and posts an incident comment + flips
 *     the issue to `shamu:blocked`.
 *
 * Composition (Phase 6.C.3) wires these together and supplies the live
 * `LinearClient`, `supervisorBus`, and `isReadyLabelId` predicate. No
 * runtime glue lives in this package.
 */

export type { Attachment, AttachPrToIssueOptions } from "./attachments.ts";
export { attachPrToIssue } from "./attachments.ts";
export type {
  RollingComment,
  RollingCommentHandle,
  RollingCommentOptions,
} from "./comments.ts";
export { createRollingComment } from "./comments.ts";
export type { EscalationSinkHandle, EscalationSinkOptions } from "./escalation-sink.ts";
export { createEscalationSink } from "./escalation-sink.ts";
export type { LabelStateMachine, LabelStateMachineOptions } from "./labels.ts";
export { createLabelStateMachine } from "./labels.ts";
export type { PickupDriverHandle, PickupDriverOptions } from "./pickup.ts";
export { createPickupDriver } from "./pickup.ts";
export type {
  RateLimiter,
  RateLimiterOptions,
  TokenLease,
} from "./rate-limiter.ts";
export { createRateLimiter, RateLimiterOverflowError } from "./rate-limiter.ts";
export type { RunIssueRegistry } from "./registry.ts";
export { createRunIssueRegistry } from "./registry.ts";
export type {
  Checkpoint,
  EscalationTemplate,
  LinearPickup,
  ShamuLabelName,
} from "./types.ts";
export { DEFAULT_ESCALATION_TEMPLATES, SHAMU_LABEL_NAMES, SHAMU_LABELS } from "./types.ts";
