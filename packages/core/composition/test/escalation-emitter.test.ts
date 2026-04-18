/**
 * Unit tests for `createEscalationEmitter`.
 *
 * Scope: the emitter is a pure pass-through layer — source emitters
 * forward onto a supervisor bus, translated to `EscalationRaised`. We
 * assert the translation's field mapping (cause, target, reason
 * carries evidence) and the stop() path (subsequent emits become
 * no-ops).
 *
 * We do NOT spin up the real watchdog subprocess or a SQLite DB here;
 * the source events are constructed as plain objects because the
 * emitter contract is "I forward what you hand me."
 */

import { describe, expect, it } from "bun:test";
import { EventBus } from "@shamu/core-supervisor/bus";
import type { SupervisorEvent } from "@shamu/core-supervisor/events";
import type { MailboxEscalationRaised } from "@shamu/mailbox";
import type { RunId } from "@shamu/shared/ids";
import type { WatchdogAlert, WatchdogCiTripwire, WatchdogHint } from "@shamu/watchdog";
import { createEscalationEmitter } from "../src/escalation-emitter.ts";

function makeBus(): EventBus<SupervisorEvent> {
  return new EventBus<SupervisorEvent>();
}

const RUN = "01HZXRUN0000000000000000EE" as RunId;

describe("createEscalationEmitter — watchdog alerts", () => {
  it("forwards a WatchdogAlert as an EscalationRaised on the supervisor bus", () => {
    const bus = makeBus();
    const received: SupervisorEvent[] = [];
    bus.subscribe((ev) => received.push(ev));

    const { watchdogEmitter } = createEscalationEmitter({ supervisorBus: bus });

    const alert: WatchdogAlert = {
      kind: "watchdog.alert",
      runId: RUN,
      vendor: "claude",
      role: "executor",
      signals: ["checkpoint_lag", "no_write_activity"],
      confidence: "high",
      at: 1_700_000_000_000,
      reason: "executor stalled: no checkpoint in 25m, no writes in 15m",
      observations: [
        // Shape of individual observations isn't under test here; we
        // only need the alert envelope.
        {
          signal: "checkpoint_lag",
          runId: RUN,
          vendor: "claude",
          role: "executor",
          confidence: "medium",
          at: 1_700_000_000_000,
          reason: "checkpoint lag",
          detail: {},
        },
        {
          signal: "no_write_activity",
          runId: RUN,
          vendor: "claude",
          role: "executor",
          confidence: "high",
          at: 1_700_000_000_000,
          reason: "no writes",
          detail: {},
        },
      ],
    };

    watchdogEmitter.emit(alert);

    expect(received).toHaveLength(1);
    const ev = received[0];
    if (!ev || ev.kind !== "escalation_raised") {
      throw new Error("Expected an escalation_raised event");
    }
    expect(ev.cause).toBe("watchdog_agreement");
    expect(ev.target).toBe("role");
    expect(ev.roleId).toBe("executor");
    expect(ev.childId).toBe(RUN);
    expect(ev.at).toBe(1_700_000_000_000);
    expect(ev.restartsInWindow).toBe(0);
    // Evidence preserved: signal pair + confidence embedded in reason.
    expect(ev.reason).toContain("checkpoint_lag+no_write_activity");
    expect(ev.reason).toContain("confidence=high");
    expect(ev.reason).toContain("executor stalled");
  });

  it("suppresses WatchdogHint — hints are below the escalation threshold", () => {
    const bus = makeBus();
    const received: SupervisorEvent[] = [];
    bus.subscribe((ev) => received.push(ev));

    const { watchdogEmitter } = createEscalationEmitter({ supervisorBus: bus });

    const hint: WatchdogHint = {
      kind: "watchdog.hint",
      runId: RUN,
      signal: "cost_velocity",
      confidence: "low",
      at: 1_700_000_000_000,
      reason: "isolated low-confidence cost signal",
      detail: {},
    };

    watchdogEmitter.emit(hint);
    expect(received).toHaveLength(0);
  });

  it("falls back to the injected clock when the alert's at is zero", () => {
    const bus = makeBus();
    const received: SupervisorEvent[] = [];
    bus.subscribe((ev) => received.push(ev));

    const { watchdogEmitter } = createEscalationEmitter({
      supervisorBus: bus,
      now: () => 42,
    });

    watchdogEmitter.emit({
      kind: "watchdog.alert",
      runId: RUN,
      vendor: null,
      role: null,
      signals: ["checkpoint_lag", "tool_loop"],
      confidence: "medium",
      at: 0,
      reason: "missing timestamp",
      observations: [
        {
          signal: "checkpoint_lag",
          runId: RUN,
          vendor: null,
          role: null,
          confidence: "medium",
          at: 0,
          reason: "",
          detail: {},
        },
        {
          signal: "tool_loop",
          runId: RUN,
          vendor: null,
          role: null,
          confidence: "medium",
          at: 0,
          reason: "",
          detail: {},
        },
      ],
    });
    const ev = received[0];
    if (!ev || ev.kind !== "escalation_raised") {
      throw new Error("Expected escalation");
    }
    expect(ev.at).toBe(42);
  });
});

describe("createEscalationEmitter — mailbox escalations", () => {
  it("forwards a MailboxEscalationRaised (dirty holder) → EscalationRaised", () => {
    const bus = makeBus();
    const received: SupervisorEvent[] = [];
    bus.subscribe((ev) => received.push(ev));

    const { mailboxEmitter } = createEscalationEmitter({ supervisorBus: bus });

    const mail: MailboxEscalationRaised = {
      kind: "escalation_raised",
      swarmId: "swarm-a",
      roleId: null,
      childId: "executor-1",
      cause: "lease_reclaim_refused_dirty_holder",
      reason: "Lease 01H holder has uncommitted changes in src/**",
      at: 1_700_000_000_500,
      restartsInWindow: 0,
      target: "role",
    };

    mailboxEmitter.emit(mail);

    expect(received).toHaveLength(1);
    const ev = received[0];
    if (!ev || ev.kind !== "escalation_raised") {
      throw new Error("Expected an escalation_raised event");
    }
    expect(ev.cause).toBe("lease_reclaim_refused");
    expect(ev.target).toBe("role");
    expect(ev.swarmId).toBe("swarm-a");
    expect(ev.childId).toBe("executor-1");
    // Original granular cause preserved in reason for evidence.
    expect(ev.reason).toContain("lease_reclaim_refused_dirty_holder");
    expect(ev.reason).toContain("uncommitted changes");
  });

  it("preserves target=swarm for holder-missing (catastrophic)", () => {
    const bus = makeBus();
    const received: SupervisorEvent[] = [];
    bus.subscribe((ev) => received.push(ev));

    const { mailboxEmitter } = createEscalationEmitter({ supervisorBus: bus });

    mailboxEmitter.emit({
      kind: "escalation_raised",
      swarmId: "swarm-b",
      roleId: null,
      childId: "worker-a",
      cause: "lease_reclaim_refused_holder_missing",
      reason: "Worktree /tmp/missing vanished",
      at: 1_700_000_001_000,
      restartsInWindow: 0,
      target: "swarm",
    });

    const ev = received[0];
    if (!ev || ev.kind !== "escalation_raised") {
      throw new Error("Expected escalation");
    }
    expect(ev.target).toBe("swarm");
    expect(ev.reason).toContain("lease_reclaim_refused_holder_missing");
  });
});

describe("createEscalationEmitter — stop()", () => {
  it("drops subsequent watchdog + mailbox emits after stop()", () => {
    const bus = makeBus();
    const received: SupervisorEvent[] = [];
    bus.subscribe((ev) => received.push(ev));

    const handle = createEscalationEmitter({ supervisorBus: bus });

    // One emission pre-stop to confirm the pipe is live.
    handle.watchdogEmitter.emit({
      kind: "watchdog.alert",
      runId: RUN,
      vendor: null,
      role: null,
      signals: ["checkpoint_lag", "tool_loop"],
      confidence: "medium",
      at: 1,
      reason: "pre-stop",
      observations: [
        {
          signal: "checkpoint_lag",
          runId: RUN,
          vendor: null,
          role: null,
          confidence: "medium",
          at: 1,
          reason: "",
          detail: {},
        },
        {
          signal: "tool_loop",
          runId: RUN,
          vendor: null,
          role: null,
          confidence: "medium",
          at: 1,
          reason: "",
          detail: {},
        },
      ],
    });
    expect(received).toHaveLength(1);

    handle.stop();

    handle.watchdogEmitter.emit({
      kind: "watchdog.alert",
      runId: RUN,
      vendor: null,
      role: null,
      signals: ["checkpoint_lag", "tool_loop"],
      confidence: "high",
      at: 2,
      reason: "post-stop (should be dropped)",
      observations: [
        {
          signal: "checkpoint_lag",
          runId: RUN,
          vendor: null,
          role: null,
          confidence: "high",
          at: 2,
          reason: "",
          detail: {},
        },
        {
          signal: "tool_loop",
          runId: RUN,
          vendor: null,
          role: null,
          confidence: "high",
          at: 2,
          reason: "",
          detail: {},
        },
      ],
    });
    handle.mailboxEmitter.emit({
      kind: "escalation_raised",
      swarmId: null,
      roleId: null,
      childId: "x",
      cause: "lease_reclaim_refused_dirty_holder",
      reason: "post-stop",
      at: 3,
      restartsInWindow: 0,
      target: "role",
    });

    expect(received).toHaveLength(1);
  });
});

describe("createEscalationEmitter — CI tripwire", () => {
  const RUN_A = "01HZXRUN0000000000000000AA" as RunId;
  const RUN_B = "01HZXRUN0000000000000000BB" as RunId;
  const RUN_C = "01HZXRUN0000000000000000CC" as RunId;

  it("forwards a WatchdogCiTripwire (threshold=3) as EscalationRaised with ci_tripwire cause", () => {
    const bus = makeBus();
    const received: SupervisorEvent[] = [];
    bus.subscribe((ev) => received.push(ev));

    const { watchdogEmitter } = createEscalationEmitter({ supervisorBus: bus });

    const tripwire: WatchdogCiTripwire = {
      kind: "watchdog.ci_tripwire",
      role: "executor",
      runIds: [RUN_A, RUN_B, RUN_C],
      at: 1_700_000_000_000,
      threshold: 3,
      reason: "CI red streak: 3 consecutive failures for role executor",
      detail: { workflow: "ci.yml" },
    };

    watchdogEmitter.emitCiTripwire?.(tripwire);

    expect(received).toHaveLength(1);
    const ev = received[0];
    if (!ev || ev.kind !== "escalation_raised") {
      throw new Error("Expected an escalation_raised event");
    }
    expect(ev.cause).toBe("ci_tripwire");
    expect(ev.target).toBe("role");
    expect(ev.roleId).toBe("executor");
    expect(ev.swarmId).toBeNull();
    // childId is the last (newest) run that tripped the wire.
    expect(ev.childId).toBe(RUN_C);
    expect(ev.restartsInWindow).toBe(0);
    expect(ev.at).toBe(1_700_000_000_000);
    // Evidence preserved: first..last streak and threshold embedded in reason.
    expect(ev.reason).toContain(`runIds=${RUN_A}..${RUN_C}`);
    expect(ev.reason).toContain("threshold=3");
    expect(ev.reason).toContain("CI red streak");
  });

  it("threshold=1 path renders a single runId without the `..` range marker", () => {
    const bus = makeBus();
    const received: SupervisorEvent[] = [];
    bus.subscribe((ev) => received.push(ev));

    const { watchdogEmitter } = createEscalationEmitter({ supervisorBus: bus });

    watchdogEmitter.emitCiTripwire?.({
      kind: "watchdog.ci_tripwire",
      role: "executor",
      runIds: [RUN_A],
      at: 1_700_000_000_000,
      threshold: 1,
      reason: "CI red streak: 1 consecutive failures for role executor",
      detail: {},
    });

    const ev = received[0];
    if (!ev || ev.kind !== "escalation_raised") {
      throw new Error("Expected an escalation_raised event");
    }
    expect(ev.childId).toBe(RUN_A);
    expect(ev.reason).toContain(`runIds=${RUN_A} threshold=1`);
    expect(ev.reason).not.toContain("..");
  });

  it("defends against empty runIds — no throw, childId falls back to role, reason flags runCount=0", () => {
    const bus = makeBus();
    const received: SupervisorEvent[] = [];
    bus.subscribe((ev) => received.push(ev));

    const { watchdogEmitter } = createEscalationEmitter({ supervisorBus: bus });

    expect(() =>
      watchdogEmitter.emitCiTripwire?.({
        kind: "watchdog.ci_tripwire",
        role: "executor",
        runIds: [],
        at: 1_700_000_000_000,
        threshold: 3,
        reason: "malformed tripwire — empty runIds",
        detail: {},
      }),
    ).not.toThrow();

    expect(received).toHaveLength(1);
    const ev = received[0];
    if (!ev || ev.kind !== "escalation_raised") {
      throw new Error("Expected an escalation_raised event");
    }
    expect(ev.childId).toBe("executor");
    expect(ev.reason).toContain("runCount=0");
  });

  it("stop() makes emitCiTripwire a no-op", () => {
    const bus = makeBus();
    const received: SupervisorEvent[] = [];
    bus.subscribe((ev) => received.push(ev));

    const handle = createEscalationEmitter({ supervisorBus: bus });

    handle.watchdogEmitter.emitCiTripwire?.({
      kind: "watchdog.ci_tripwire",
      role: "executor",
      runIds: [RUN_A, RUN_B, RUN_C],
      at: 1,
      threshold: 3,
      reason: "pre-stop",
      detail: {},
    });
    expect(received).toHaveLength(1);

    handle.stop();

    handle.watchdogEmitter.emitCiTripwire?.({
      kind: "watchdog.ci_tripwire",
      role: "executor",
      runIds: [RUN_A, RUN_B, RUN_C],
      at: 2,
      threshold: 3,
      reason: "post-stop (should be dropped)",
      detail: {},
    });
    expect(received).toHaveLength(1);
  });

  it("at <= 0 falls back to the injected now()", () => {
    const bus = makeBus();
    const received: SupervisorEvent[] = [];
    bus.subscribe((ev) => received.push(ev));

    const { watchdogEmitter } = createEscalationEmitter({
      supervisorBus: bus,
      now: () => 4242,
    });

    watchdogEmitter.emitCiTripwire?.({
      kind: "watchdog.ci_tripwire",
      role: "executor",
      runIds: [RUN_A, RUN_B, RUN_C],
      at: 0,
      threshold: 3,
      reason: "missing timestamp",
      detail: {},
    });

    const ev = received[0];
    if (!ev || ev.kind !== "escalation_raised") {
      throw new Error("Expected escalation");
    }
    expect(ev.at).toBe(4242);
  });
});
