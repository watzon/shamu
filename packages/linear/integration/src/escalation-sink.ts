/**
 * Escalation sink — subscribes to a supervisor `EventBus<SupervisorEvent>`,
 * filters `escalation_raised`, and reports each one on the Linear issue the
 * run is bound to by (1) posting a stand-alone incident comment and (2)
 * flipping the issue's label to `shamu:blocked`.
 *
 * Why a stand-alone comment (not merged into the rolling comment): the
 * rolling comment is a progress log for the run-owning agent; escalations
 * are out-of-band incident reports targeted at the human who triages
 * blocked issues. Keeping them separate means the rolling comment stays
 * noise-free and the incident comment is easy to spot in Linear's UI.
 *
 * Listener shape:
 *
 *   The EventBus dispatches synchronously — listeners MUST be sync or the
 *   bus will swallow unhandled rejections. We wrap the async reporting
 *   work in a fire-and-forget IIFE so the listener returns immediately;
 *   rejections on the IIFE are caught and logged to avoid killing the
 *   process via the default unhandled-rejection handler.
 *
 *   Two operations run sequentially inside the IIFE:
 *
 *     1. `client.createComment(issueId, body)` — a new comment, not a
 *        rolling-comment update.
 *     2. `labelMachine.transition({ issueId, to: "shamu:blocked" })`.
 *
 *   Failures on either one are logged and the other still proceeds. Best-
 *   effort "we tried" beats silent swallow.
 *
 * Unknown `EscalationCause`:
 *
 *   If a future supervisor variant arrives that isn't in the template
 *   table, we synthesize a generic template from the cause string rather
 *   than silently dropping. That guarantees NEW causes still surface to
 *   Linear, with the exact cause name in the comment for forensic value.
 */

import type { EventBus } from "@shamu/core-supervisor";
import type {
  EscalationCause,
  EscalationRaised,
  SupervisorEvent,
} from "@shamu/core-supervisor/events";
import type { LinearClient } from "@shamu/linear-client";
import type { RunId } from "@shamu/shared/ids";
import type { Logger } from "@shamu/shared/logger";
import type { LabelStateMachine } from "./labels.ts";
import type { RunIssueRegistry } from "./registry.ts";
import { DEFAULT_ESCALATION_TEMPLATES, type EscalationTemplate, SHAMU_LABELS } from "./types.ts";

export interface EscalationSinkOptions {
  readonly supervisorBus: EventBus<SupervisorEvent>;
  readonly client: LinearClient;
  readonly registry: RunIssueRegistry;
  readonly labelMachine: LabelStateMachine;
  readonly templates?: readonly EscalationTemplate[];
  readonly logger?: Logger;
  readonly now?: () => number;
}

export interface EscalationSinkHandle {
  /** Unsubscribe and stop processing further events. Idempotent. */
  stop(): void;
}

/** Build the comment body for one escalation. Pure; safe to snapshot-test. */
function renderBody(template: EscalationTemplate, event: EscalationRaised, at: number): string {
  const iso = new Date(at).toISOString();
  const role = event.roleId ?? "unknown";
  return `## ${template.headline}\n\n${template.bodyPrefix}\n\n> ${event.reason}\n\n_runId: ${event.childId} role: ${role} at: ${iso}_`;
}

/** Fallback template when a brand-new `EscalationCause` isn't in the table. */
function syntheticTemplate(cause: EscalationCause): EscalationTemplate {
  return {
    cause,
    headline: `Escalation: ${cause}`,
    bodyPrefix: `Supervisor raised an unmapped escalation cause (${cause}).`,
  };
}

export function createEscalationSink(opts: EscalationSinkOptions): EscalationSinkHandle {
  const templates = opts.templates ?? DEFAULT_ESCALATION_TEMPLATES;
  const byCause = new Map<EscalationCause, EscalationTemplate>();
  for (const t of templates) byCause.set(t.cause, t);
  const logger = opts.logger;
  const now = opts.now ?? Date.now;
  let stopped = false;

  const dispose = opts.supervisorBus.subscribe((event: SupervisorEvent) => {
    if (stopped) return;
    if (event.kind !== "escalation_raised") return;

    // `childId` is typed as `string` on the supervisor event, but the
    // 6.C.1 escalation-emitter layer stamps it with the `RunId` that the
    // orchestrator minted. We cast to `RunId` here so the registry lookup
    // is typed correctly; the value itself is byte-identical.
    const issueId = opts.registry.issueIdFor(event.childId as RunId);
    if (issueId === null) {
      // Real scenario: `start_failed` can fire before the run is bound to
      // an issue (e.g. a pickup whose first child crashed on spawn).
      logger?.warn("linear escalation-sink: no issue binding for runId", {
        childId: event.childId,
        cause: event.cause,
        reason: event.reason,
      });
      return;
    }

    const template = byCause.get(event.cause) ?? syntheticTemplate(event.cause);
    const body = renderBody(template, event, now());

    // Fire-and-forget; the listener must return sync so the bus can
    // continue dispatching to other subscribers. We attach a `.catch` so a
    // reject from the inner IIFE can't crash the process via the default
    // unhandled-rejection handler.
    void (async () => {
      if (stopped) return;
      const commentRes = await opts.client.createComment(issueId, body);
      if (!commentRes.ok) {
        logger?.error("linear escalation-sink: createComment failed", {
          issueId,
          childId: event.childId,
          cause: event.cause,
          kind: commentRes.error.kind,
          message: commentRes.error.message,
        });
      }
      if (stopped) return;
      const labelRes = await opts.labelMachine.transition({
        issueId,
        to: SHAMU_LABELS.blocked,
      });
      if (!labelRes.ok) {
        logger?.error("linear escalation-sink: label transition to blocked failed", {
          issueId,
          childId: event.childId,
          cause: event.cause,
          kind: labelRes.error.kind,
          message: labelRes.error.message,
        });
      }
    })().catch((cause) => {
      logger?.error("linear escalation-sink: unhandled error in async handler", {
        childId: event.childId,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    });
  });

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      dispose();
    },
  };
}
