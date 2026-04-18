/**
 * Local supervisor domain events.
 *
 * PLAN.md § 4: the supervisor publishes typed events on an in-memory bus.
 * `EscalationRaised` is the only one required by Track 3.A; `ChildStarted`,
 * `ChildStopped`, and `ChildRestarted` are lifecycle traces that downstream
 * surfaces (CLI status line, TUI, persistence projections) can opt into
 * without paying the cost if they don't subscribe.
 *
 * Cause taxonomy:
 *   - "intensity_exceeded"    — restart budget for this child tripped the
 *                               role's policy; no further restart attempted.
 *   - "start_failed"          — a factory rejected on first-start; treated
 *                               as an unrecoverable crash inside `start()`.
 *   - "policy_violation"      — reserved catch-all; the supervisor and the
 *                               composition escalation emitter do NOT emit
 *                               this, but flows/orchestrators layered
 *                               above may still publish it on the same
 *                               bus for hand-authored policies that don't
 *                               fit a more specific variant.
 *   - "watchdog_agreement"    — two distinct watchdog signals reached
 *                               agreement for one run (see
 *                               `@shamu/watchdog` `WatchdogAlert`).
 *   - "lease_reclaim_refused" — mailbox refused a stale-lease reclaim
 *                               (dirty holder or missing worktree).
 *   - "ci_tripwire"           — per-role CI red-streak tripwire fired (N
 *                               consecutive red CI runs for one role).
 *
 * Keeping the cause a string-literal union (not a free string) is what
 * lets a downstream Linear sink switch on the shape without ad-hoc
 * parsing.
 */

export type EscalationCause =
  | "intensity_exceeded"
  | "start_failed"
  | "policy_violation"
  | "watchdog_agreement"
  | "lease_reclaim_refused"
  | "ci_tripwire";

/**
 * Published when a child cannot be restarted under its role's policy.
 *
 * - `swarmId`      — identity of the swarm that owns the role. `null` for
 *                    supervisors built outside a swarm (e.g. standalone
 *                    tests).
 * - `roleId`       — name of the role supervisor. `null` for a supervisor
 *                    that wasn't wrapped by a role.
 * - `childId`      — stable id from the child's `ChildSpec`.
 * - `cause`        — typed enum; see above.
 * - `reason`       — human-readable detail, e.g. "crashed 6 times in 300s".
 * - `at`           — wall-clock ms when the supervisor decided to escalate.
 * - `restartsInWindow` — restart count inside the policy window at the
 *                    moment of the decision. Useful for dashboards.
 * - `target`       — where the supervisor thinks the escalation should
 *                    travel: either the role stops (`"role"`) or the whole
 *                    swarm should be halted by the listener (`"swarm"`).
 *                    Pulled from the policy; the bus does not act on it,
 *                    only publishes.
 */
export interface EscalationRaised {
  readonly kind: "escalation_raised";
  readonly swarmId: string | null;
  readonly roleId: string | null;
  readonly childId: string;
  readonly cause: EscalationCause;
  readonly reason: string;
  readonly at: number;
  readonly restartsInWindow: number;
  readonly target: "role" | "swarm";
}

/** Emitted after a child successfully starts or restarts. */
export interface ChildStarted {
  readonly kind: "child_started";
  readonly swarmId: string | null;
  readonly roleId: string | null;
  readonly childId: string;
  readonly at: number;
  /** 0 on first start, then increments on each restart. */
  readonly startCount: number;
}

/** Emitted when a child is stopped cleanly by the supervisor. */
export interface ChildStopped {
  readonly kind: "child_stopped";
  readonly swarmId: string | null;
  readonly roleId: string | null;
  readonly childId: string;
  readonly at: number;
  readonly reason: string;
}

/**
 * Emitted after the supervisor has decided to restart a child because of a
 * crash/kill. This is the pre-restart marker; a successful restart is
 * followed by a `ChildStarted` with an incremented `startCount`.
 */
export interface ChildRestarted {
  readonly kind: "child_restarted";
  readonly swarmId: string | null;
  readonly roleId: string | null;
  readonly childId: string;
  readonly at: number;
  readonly exitReason: "crashed" | "killed";
}

export type SupervisorEvent = EscalationRaised | ChildStarted | ChildStopped | ChildRestarted;
export type SupervisorEventKind = SupervisorEvent["kind"];
