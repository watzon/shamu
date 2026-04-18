/**
 * Unit tests for `createEscalationSink`.
 *
 * Uses the REAL `EventBus` from `@shamu/core-supervisor` — its pub/sub is
 * pure and has no side effects, so tests exercise the full integration
 * between the bus and the sink (only the `LinearClient` is a fake).
 */

import { EventBus } from "@shamu/core-supervisor";
import type {
  EscalationCause,
  EscalationRaised,
  SupervisorEvent,
} from "@shamu/core-supervisor/events";
import type {
  CommentRef,
  LinearClient,
  LinearError as RealLinearError,
} from "@shamu/linear-client";
import { LinearError } from "@shamu/linear-client";
import { runId as brandRunId } from "@shamu/shared/ids";
import { type LogEntry, Logger } from "@shamu/shared/logger";
import { err, ok, type Result } from "@shamu/shared/result";
import { describe, expect, it } from "vitest";
import { createEscalationSink } from "../escalation-sink.ts";
import { createLabelStateMachine, type LabelStateMachine } from "../labels.ts";
import { createRunIssueRegistry } from "../registry.ts";
import { SHAMU_LABELS } from "../types.ts";

interface RecordedCall {
  readonly op: "createComment" | "getIssue" | "addLabel" | "removeLabel";
  readonly arg1: string;
  readonly arg2?: string;
  readonly body?: string;
}

interface FakeClientInit {
  readonly labelNames?: readonly string[];
  readonly createCommentResult?: () => Result<CommentRef, RealLinearError>;
  readonly addLabelResult?: () => Result<true, RealLinearError>;
  readonly removeLabelResult?: () => Result<true, RealLinearError>;
}

function makeFakeClient(init: FakeClientInit = {}): {
  client: LinearClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const labels = init.labelNames ?? [SHAMU_LABELS.inProgress];
  const client = {
    async createComment(
      issueId: string,
      body: string,
    ): Promise<Result<CommentRef, RealLinearError>> {
      calls.push({ op: "createComment", arg1: issueId, body });
      return init.createCommentResult?.() ?? ok({ id: "comment-x" });
    },
    async getIssue(id: string) {
      calls.push({ op: "getIssue", arg1: id });
      return ok({
        id,
        identifier: "SHA-1",
        title: "t",
        description: null,
        url: "u",
        teamId: "team-1",
        stateId: "s1",
        stateName: "Todo",
        labelIds: labels.map((_, i) => `label-${i}`),
        labelNames: labels,
      });
    },
    async addLabel(issueId: string, labelName: string): Promise<Result<true, RealLinearError>> {
      calls.push({ op: "addLabel", arg1: issueId, arg2: labelName });
      return init.addLabelResult?.() ?? ok(true);
    },
    async removeLabel(issueId: string, labelName: string): Promise<Result<true, RealLinearError>> {
      calls.push({ op: "removeLabel", arg1: issueId, arg2: labelName });
      return init.removeLabelResult?.() ?? ok(true);
    },
  } as unknown as LinearClient;
  return { client, calls };
}

function escalation(cause: EscalationCause, childId = "run-1"): EscalationRaised {
  return {
    kind: "escalation_raised",
    swarmId: "swarm-1",
    roleId: "executor",
    childId,
    cause,
    reason: `because of ${cause}`,
    at: 1_700_000_000_000,
    restartsInWindow: 3,
    target: "role",
  };
}

/** Drain any pending microtasks so fire-and-forget handlers complete. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function setup(_cause: EscalationCause, init?: FakeClientInit) {
  const bus = new EventBus<SupervisorEvent>();
  const registry = createRunIssueRegistry();
  registry.bind(brandRunId("run-1"), "issue-1");
  const { client, calls } = makeFakeClient(init);
  const labelMachine: LabelStateMachine = createLabelStateMachine({ client });
  const sink = createEscalationSink({
    supervisorBus: bus,
    client,
    registry,
    labelMachine,
    now: () => 1_700_000_000_000,
  });
  return { bus, registry, client, calls, sink };
}

describe("createEscalationSink — cause variants", () => {
  const causes: EscalationCause[] = [
    "ci_tripwire",
    "watchdog_agreement",
    "lease_reclaim_refused",
    "intensity_exceeded",
    "start_failed",
    "policy_violation",
  ];

  for (const cause of causes) {
    it(`cause=${cause} posts a comment with matching headline and flips to shamu:blocked`, async () => {
      const { bus, calls } = setup(cause);
      bus.publish(escalation(cause));
      await flush();
      // First call is createComment with cause-specific headline + reason body.
      const firstCreate = calls.find((c) => c.op === "createComment");
      expect(firstCreate).toBeDefined();
      if (!firstCreate) return;
      expect(firstCreate.arg1).toBe("issue-1");
      expect(firstCreate.body ?? "").toContain(`because of ${cause}`);
      expect(firstCreate.body ?? "").toContain("runId: run-1");
      // Expected headline per cause:
      const headlines: Record<EscalationCause, string> = {
        ci_tripwire: "CI red-streak tripwire",
        watchdog_agreement: "Watchdog agreement",
        lease_reclaim_refused: "Stale-lease reclaim refused",
        intensity_exceeded: "Restart budget exceeded",
        start_failed: "Child start failed",
        policy_violation: "Policy violation",
      };
      expect(firstCreate.body ?? "").toContain(headlines[cause]);
      // Label machine then transitioned to blocked.
      const addBlocked = calls.find((c) => c.op === "addLabel" && c.arg2 === SHAMU_LABELS.blocked);
      expect(addBlocked).toBeDefined();
    });
  }
});

describe("createEscalationSink — edge cases", () => {
  it("logs and skips when the runId has no issue binding", async () => {
    const bus = new EventBus<SupervisorEvent>();
    const registry = createRunIssueRegistry();
    // No bind.
    const { client, calls } = makeFakeClient();
    const labelMachine = createLabelStateMachine({ client });
    const entries: LogEntry[] = [];
    const logger = new Logger({
      level: "trace",
      transport: (entry) => {
        entries.push(entry);
      },
    });
    createEscalationSink({
      supervisorBus: bus,
      client,
      registry,
      labelMachine,
      logger,
    });
    bus.publish(escalation("ci_tripwire", "unknown-run"));
    await flush();
    // No client calls fired.
    expect(calls).toHaveLength(0);
    // Warn log recorded the skip.
    const warned = entries.find((e) => e.level === "warn" && e.context.childId === "unknown-run");
    expect(warned).toBeDefined();
  });

  it("stop() unsubscribes and subsequent events are ignored", async () => {
    const { bus, calls, sink } = setup("ci_tripwire");
    sink.stop();
    bus.publish(escalation("ci_tripwire"));
    await flush();
    expect(calls).toHaveLength(0);
    // Idempotent.
    sink.stop();
  });

  it("non-escalation events are ignored", async () => {
    const { bus, calls } = setup("ci_tripwire");
    bus.publish({
      kind: "child_started",
      swarmId: "s",
      roleId: "r",
      childId: "run-1",
      at: 1,
      startCount: 0,
    });
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("createComment failure still proceeds to label transition", async () => {
    const boom = new LinearError("http", "500");
    const { bus, calls } = setup("ci_tripwire", {
      createCommentResult: () => err(boom),
    });
    bus.publish(escalation("ci_tripwire"));
    await flush();
    // createComment attempted, then label transition still fired.
    expect(calls.some((c) => c.op === "createComment")).toBe(true);
    expect(calls.some((c) => c.op === "addLabel" && c.arg2 === SHAMU_LABELS.blocked)).toBe(true);
  });

  it("label transition failure does not re-fire the comment", async () => {
    const boom = new LinearError("forbidden", "nope");
    const { bus, calls } = setup("ci_tripwire", {
      addLabelResult: () => err(boom),
    });
    bus.publish(escalation("ci_tripwire"));
    await flush();
    const commentCount = calls.filter((c) => c.op === "createComment").length;
    expect(commentCount).toBe(1);
  });
});
