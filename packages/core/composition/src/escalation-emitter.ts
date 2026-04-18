/**
 * Escalation emitter — bridges `@shamu/mailbox` and `@shamu/watchdog`
 * events onto the `@shamu/core-supervisor` bus.
 *
 * PLAN.md § "Core architecture → 4. Supervisor" declares `EscalationRaised`
 * as a local domain event published on an in-memory bus. `@shamu/watchdog`
 * emits `WatchdogAlert` (two-observation agreement) via `WatchdogEmitter`.
 * `@shamu/mailbox` emits `MailboxEscalationRaised` (stale-lease reclaim
 * refusals) via `EscalationEmitter`. Neither primitive imports the
 * supervisor bus — keeping them clean of the supervisor's event
 * taxonomy. This module is the composition-layer shim that forwards
 * both source taxonomies onto a single `EventBus<SupervisorEvent>`.
 *
 * Source taxonomy references (resolved to actual exported names):
 *
 *   - `@shamu/watchdog` — `WatchdogAlert` + `WatchdogEmitter`
 *     (defined in `packages/watchdog/src/types.ts` and
 *      `packages/watchdog/src/events.ts`). The emitter dispatches both
 *     hints (`watchdog.hint`) and alerts (`watchdog.alert`); we subscribe
 *     via a wrapping emitter that filters to `watchdog.alert` only —
 *     hints are intentionally below the escalation threshold.
 *
 *   - `@shamu/mailbox` — `MailboxEscalationRaised` +
 *     `EscalationEmitter as MailboxEscalationEmitter`
 *     (defined in `packages/mailbox/src/escalation.ts`). The mailbox
 *     emitter fires on stale-lease reclaim refusals.
 *
 * Target taxonomy: `@shamu/core-supervisor`'s `EscalationRaised` +
 * `SupervisorEvent`. The shim publishes onto any `EventBus<SupervisorEvent>`
 * the caller hands in — typically the swarm's bus.
 *
 * Escalation-cause mapping:
 *
 *   Source                                            → Target cause
 *   ------------------------------------------------- | ------------------------
 *   watchdog.alert (any signal pair)                   → "watchdog_agreement"
 *   mailbox.lease_reclaim_refused_*                    → "lease_reclaim_refused"
 *   watchdog.ci_tripwire (per-role N-red streak)       → "ci_tripwire"
 *
 * Each of these is its own typed `EscalationCause` variant so downstream
 * sinks (Phase 6.C Linear sink, CLI, TUI) can switch on the shape without
 * parsing the `reason` string. The composition emitter does NOT emit the
 * generic `"policy_violation"` cause — that remains a reserved catch-all
 * for hand-authored callers layered above the supervisor.
 *
 * Tripwire channel — why `emitCiTripwire` is a distinct method, not
 * routed through `emit`: PLAN §6 declares the CI tripwire structurally
 * parallel to the agreement buffer, not a member of it (same-signal
 * counter across runs, role-scoped; the buffer is cross-signal inside
 * one run). The producer-side contract keeps the two channels separate
 * at the `WatchdogEmitter` seam; the composition emitter preserves that
 * separation here so a future sink can subscribe to tripwires without
 * paying the cost of every agreement alert.
 *
 * Target routing:
 *
 *   - WatchdogAlert → `target: "role"`. A signal agreement points at a
 *     specific run, which belongs to a role; the role supervisor is
 *     the right surface to halt. (Swarm-wide halts come from the
 *     supervisor's own intensity budget, not the watchdog.)
 *   - MailboxEscalationRaised → `target: "swarm"` for the missing-
 *     worktree case (catastrophic: uncommitted work may have been lost),
 *     `target: "role"` for dirty-holder (reviewer/operator needs to
 *     decide; the role stopping surfaces that need). We preserve
 *     whatever the source event's `target` already says — the mailbox
 *     already classifies correctly, so this is a pass-through.
 *   - WatchdogCiTripwire → `target: "role"`. The tripwire is role-scoped
 *     by definition; a red streak for the executor should halt the
 *     executor role, not the whole swarm.
 */

import type { EventBus } from "@shamu/core-supervisor/bus";
import type { EscalationRaised, SupervisorEvent } from "@shamu/core-supervisor/events";
import type {
  EscalationEmitter as MailboxEscalationEmitter,
  MailboxEscalationRaised,
} from "@shamu/mailbox";
import type {
  WatchdogAlert,
  WatchdogCiTripwire,
  WatchdogEmitter,
  WatchdogEvent,
} from "@shamu/watchdog";

/**
 * Options for {@link createEscalationEmitter}.
 *
 * The shim wires itself by handing the caller two emitters (one per
 * source package) that the caller passes into the source primitives
 * (`reclaimIfStale(opts.emitter = mailboxEmitter)`, `runWatchdog(emit =
 * watchdogEmitter)`). Everything the source emitters receive is
 * forwarded onto `supervisorBus`.
 */
export interface EscalationEmitterOptions {
  /** Destination bus for forwarded `EscalationRaised` events. */
  readonly supervisorBus: EventBus<SupervisorEvent>;
  /** Optional clock for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Handle returned by {@link createEscalationEmitter}.
 *
 * `watchdogEmitter` is a {@link WatchdogEmitter} the caller passes to the
 * watchdog entry point; `mailboxEmitter` is a {@link MailboxEscalationEmitter}
 * the caller passes to mailbox primitives (e.g. `reclaimIfStale`).
 *
 * `stop()` disconnects both sources from the supervisor bus by flipping
 * an internal flag — subsequent `emit()` calls on either returned
 * emitter become no-ops. Useful on shutdown.
 */
export interface EscalationEmitterHandle {
  readonly watchdogEmitter: WatchdogEmitter;
  readonly mailboxEmitter: MailboxEscalationEmitter;
  /** Flip the internal stop flag. Both emitters become no-ops. */
  stop(): void;
}

/**
 * Create a composition shim that forwards mailbox + watchdog events onto
 * the supervisor bus.
 *
 * Because neither source primitive holds an EventBus reference itself —
 * they accept an injected emitter — the "subscribe" action here is
 * producing the emitter the caller wires in. That's also why there's no
 * implicit pump or background loop: events flow synchronously as the
 * source primitives fire.
 */
export function createEscalationEmitter(opts: EscalationEmitterOptions): EscalationEmitterHandle {
  const { supervisorBus } = opts;
  const now = opts.now ?? Date.now;
  let stopped = false;

  const watchdogEmitter: WatchdogEmitter = {
    emit(event: WatchdogEvent): void {
      if (stopped) return;
      // Hints intentionally do not escalate. Only two-observation
      // agreement alerts reach the supervisor bus via this entry point;
      // tripwires arrive through `emitCiTripwire` below so the two
      // channels stay structurally separated (PLAN §6).
      if (event.kind !== "watchdog.alert") return;
      supervisorBus.publish(translateWatchdogAlert(event, now()));
    },
    emitCiTripwire(event: WatchdogCiTripwire): void {
      if (stopped) return;
      supervisorBus.publish(translateCiTripwire(event, now()));
    },
  };

  const mailboxEmitter: MailboxEscalationEmitter = {
    emit(event: MailboxEscalationRaised): void {
      if (stopped) return;
      supervisorBus.publish(translateMailboxEscalation(event));
    },
  };

  return {
    watchdogEmitter,
    mailboxEmitter,
    stop(): void {
      stopped = true;
    },
  };
}

/**
 * Translate a `WatchdogAlert` into the supervisor's `EscalationRaised`.
 *
 * - `swarmId` / `roleId`: the watchdog cannot resolve these without the
 *   flow engine. We use `null` for swarm and the alert's `role` (nullable)
 *   for role. Downstream sinks that need a swarm id must look it up via
 *   the run registry — that's why `runId` is preserved in `childId` and
 *   `reason`.
 * - `childId`: the `runId` the alert is scoped to; aligns with how the
 *   supervisor identifies children elsewhere.
 * - `reason`: carries the watchdog's own reason verbatim so the evidence
 *   is not dropped. The confidence pair + signal pair are appended as
 *   a readable suffix so a CLI sink can render one line without parsing.
 * - `restartsInWindow`: 0. The watchdog doesn't track restart budgets;
 *   the field is supervisor-native and there's no sensible value here.
 */
function translateWatchdogAlert(alert: WatchdogAlert, at: number): EscalationRaised {
  const signalsLabel = `${alert.signals[0]}+${alert.signals[1]}`;
  const reason = `${alert.reason} [signals=${signalsLabel} confidence=${alert.confidence}]`;
  return {
    kind: "escalation_raised",
    swarmId: null,
    roleId: alert.role,
    childId: alert.runId,
    cause: "watchdog_agreement",
    reason,
    // Prefer the alert's own wall-clock for replay fidelity; fall back
    // to the injected clock only if the alert didn't carry one.
    at: alert.at > 0 ? alert.at : at,
    restartsInWindow: 0,
    target: "role",
  };
}

/**
 * Translate a `MailboxEscalationRaised` into the supervisor's
 * `EscalationRaised`.
 *
 * The mailbox event is already structurally compatible (same `kind`,
 * same field names). The translation collapses the mailbox-specific
 * cause enum (`lease_reclaim_refused_dirty_holder` /
 * `lease_reclaim_refused_holder_missing`) into the supervisor's
 * `"lease_reclaim_refused"` variant and preserves the original granular
 * cause inside `reason` for downstream disambiguation.
 */
function translateMailboxEscalation(event: MailboxEscalationRaised): EscalationRaised {
  return {
    kind: "escalation_raised",
    swarmId: event.swarmId,
    roleId: event.roleId,
    childId: event.childId,
    cause: "lease_reclaim_refused",
    reason: `${event.reason} [mailbox_cause=${event.cause}]`,
    at: event.at,
    restartsInWindow: event.restartsInWindow,
    target: event.target,
  };
}

/**
 * Translate a `WatchdogCiTripwire` into the supervisor's
 * `EscalationRaised`.
 *
 * - `swarmId`: null. The watchdog layer does not resolve swarm id (same
 *   rationale as `translateWatchdogAlert`); a sink that needs it looks
 *   up the runs referenced in `reason` against the run registry.
 * - `childId`: the run that tripped the wire — the last (newest) runId
 *   in the streak. If `runIds` is empty (defensive — the tripwire
 *   producer guarantees at least `threshold` entries today), fall back
 *   to the role name as a deterministic placeholder and annotate
 *   `runCount=0` in the reason so the downstream operator can see the
 *   shape was unexpected.
 * - `reason`: the tripwire's own reason followed by a bracketed suffix
 *   that renders the streak compactly — `<first>..<last>` for >1 run,
 *   just the single id for exactly one.
 * - `target`: always `"role"`. The tripwire is role-scoped by definition.
 */
function translateCiTripwire(event: WatchdogCiTripwire, at: number): EscalationRaised {
  const runCount = event.runIds.length;
  const last = runCount > 0 ? event.runIds[runCount - 1] : undefined;
  const first = runCount > 0 ? event.runIds[0] : undefined;
  const childId = last ?? event.role;
  let streakLabel: string;
  if (runCount === 0) {
    streakLabel = "runCount=0";
  } else if (runCount === 1) {
    streakLabel = `runIds=${first} threshold=${event.threshold}`;
  } else {
    streakLabel = `runIds=${first}..${last} threshold=${event.threshold}`;
  }
  return {
    kind: "escalation_raised",
    swarmId: null,
    roleId: event.role,
    childId,
    cause: "ci_tripwire",
    reason: `${event.reason} [${streakLabel}]`,
    at: event.at > 0 ? event.at : at,
    restartsInWindow: 0,
    target: "role",
  };
}
