/**
 * Runner tests using the in-test fake adapters.
 *
 * Tests the planner/executor/reviewer/loop-predicate runners with the
 * `__adapterOverride` seam so no real vendor CLI is touched. Covers the
 * reviewer-internal revise->retry loop and the loop-predicate's terminal
 * semantics.
 */

import type { GateResult, RunGateOptions } from "@shamu/ci";
import type { RunnerContext } from "@shamu/core-flow/runners";
import { RunnerRegistry } from "@shamu/core-flow/runners";
import type { NodeId, NodeOutput } from "@shamu/core-flow/types";
import { newWorkflowRunId } from "@shamu/shared/ids";
import { describe, expect, test } from "vitest";
import { flowDefinition } from "../src/flow.ts";
import type { AdapterOverride, CIRunOverride } from "../src/runners.ts";
import { registerRunners } from "../src/runners.ts";
import type {
  CINodeOutput,
  ExecutorOutput,
  PlannerOutput,
  ReviewerModelOutput,
  ReviewerVerdict,
} from "../src/schemas.ts";
import type { FakeAdapterScript } from "./_fake-adapter.ts";
import { FAKE_CLAUDE_CAPS, FAKE_CODEX_CAPS, FakeAdapter, fencedJson } from "./_fake-adapter.ts";

const SAMPLE_PLAN: PlannerOutput = {
  goal: "add a readme heading",
  steps: [{ id: "s1", description: "insert heading", filesTouched: ["README.md"] }],
  assumptions: [],
};

const SAMPLE_EXEC: ExecutorOutput = {
  summary: "inserted the heading",
  diffStats: { added: 1, removed: 0, files: ["README.md"] },
  notes: "",
};

const APPROVE: ReviewerModelOutput = {
  verdict: "approve",
  feedback: "looks good",
  concerns: [],
};

const REVISE: ReviewerModelOutput = {
  verdict: "revise",
  feedback: "missing the table of contents update",
  concerns: ["toc stale"],
};

/** Helper: build a runnerContext matching one of our five node ids. */
function buildCtx(params: {
  readonly nodeKey: "plan" | "execute" | "ci" | "review" | "loop";
  readonly initial?: Record<string, unknown>;
  readonly priorOutputs?: Record<string, NodeOutput>;
}): RunnerContext {
  const node = flowDefinition.nodes.find((n) => n.id === params.nodeKey);
  if (!node) throw new Error(`missing node: ${params.nodeKey}`);
  return {
    flowRunId: newWorkflowRunId(),
    node,
    inputs: { initial: params.initial ?? {}, deps: {}, node: {} },
    priorOutputs: (params.priorOutputs ?? {}) as Record<NodeId, NodeOutput>,
    signal: new AbortController().signal,
  };
}

function okOutput(value: unknown, overrides: Partial<NodeOutput> = {}): NodeOutput {
  return {
    ok: true,
    value,
    costUsd: null,
    costConfidence: "unknown",
    costSource: "test",
    ...overrides,
  };
}

/**
 * Minimal scripted gate-result factory. The reviewer's internal re-run loop
 * and the ci runner both accept this through `__ciRunOverride`.
 */
function makeGateResult(params: {
  readonly runId?: string;
  readonly status: "green" | "red" | "unknown";
  readonly excerpt?: string;
}): GateResult {
  const runId = params.runId ?? "test-ci-run";
  const summary: GateResult["summary"] = {
    runId,
    status: params.status,
    durationMs: 0,
    workflows: [],
    totalSteps: 0,
    failedSteps: [],
  };
  const domainEvent: GateResult["domainEvent"] =
    params.status === "red"
      ? {
          kind: "CIRed",
          runId,
          summary,
          reviewerExcerpt: params.excerpt ?? "RED: tests failed",
        }
      : { kind: "PatchReady", runId, summary };
  return {
    exitCode: params.status === "red" ? 1 : 0,
    stdout: "",
    stderr: "",
    runDir: `/tmp/fake-ci/${runId}`,
    summary,
    domainEvent,
  };
}

/** Build a ci priorOutput stub matching what the `ci` runner would emit. */
function ciPriorOutput(params: {
  readonly status: "green" | "red" | "unknown";
  readonly excerpt?: string | null;
  readonly runId?: string;
}): NodeOutput {
  const runId = params.runId ?? "test-ci-run";
  const value: CINodeOutput = {
    kind: params.status === "red" ? "CIRed" : "PatchReady",
    runId,
    summary: {
      runId,
      status: params.status,
      durationMs: 0,
      workflows: [],
      totalSteps: 0,
      failedSteps: [],
    },
    reviewerExcerpt: params.excerpt ?? null,
  };
  return okOutput(value);
}

interface BuildRegistryInput {
  readonly planner?: FakeAdapterScript | (() => FakeAdapterScript);
  readonly executor?: FakeAdapterScript | ((idx: number) => FakeAdapterScript);
  readonly reviewer?: FakeAdapterScript | ((idx: number) => FakeAdapterScript);
  readonly maxIterations?: number;
  /**
   * Scripted ci gate. Default produces a green PatchReady so existing tests
   * that don't care about CI keep their previous behavior (reviewer sees
   * green CI, is not forced to revise, approves as before).
   */
  readonly ciRun?: CIRunOverride;
  /**
   * Forwarded to `RegisterRunnersOptions.spawnEnv`. Lets a test assert that
   * egress-broker env reaches every runner's `SpawnOpts.env`.
   */
  readonly spawnEnv?: Readonly<Record<string, string>>;
}

interface BuildRegistryResult {
  readonly registry: RunnerRegistry;
  readonly plannerAdapter: FakeAdapter;
  readonly executorAdapter: FakeAdapter;
  readonly reviewerAdapter: FakeAdapter;
  readonly ciCalls: RunGateOptions[];
}

function buildRegistry(input: BuildRegistryInput): BuildRegistryResult {
  const plannerScript = scriptFnFrom(input.planner ?? { finalAssistantText: "" });
  const executorScript = scriptFnFrom(input.executor ?? { finalAssistantText: "" });
  const reviewerScript = scriptFnFrom(input.reviewer ?? { finalAssistantText: "" });

  const plannerAdapter = new FakeAdapter({
    vendor: "codex",
    capabilities: FAKE_CODEX_CAPS,
    scriptFor: plannerScript,
  });
  const executorAdapter = new FakeAdapter({
    vendor: "claude",
    capabilities: FAKE_CLAUDE_CAPS,
    scriptFor: executorScript,
  });
  const reviewerAdapter = new FakeAdapter({
    vendor: "codex",
    capabilities: FAKE_CODEX_CAPS,
    scriptFor: reviewerScript,
  });
  const registry = new RunnerRegistry();
  const override: AdapterOverride = {
    plannerAdapter: () => plannerAdapter,
    executorAdapter: () => executorAdapter,
    reviewerAdapter: () => reviewerAdapter,
  };
  const ciCalls: RunGateOptions[] = [];
  const userCiRun = input.ciRun;
  const wrappedCiRun: CIRunOverride =
    userCiRun !== undefined
      ? async (opts) => {
          ciCalls.push(opts);
          return userCiRun(opts);
        }
      : async (opts) => {
          ciCalls.push(opts);
          return makeGateResult({ status: "green" });
        };
  registerRunners(registry, {
    workspaceCwd: "/tmp/shamu-fake",
    __adapterOverride: override,
    __ciRunOverride: wrappedCiRun,
    ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
    ...(input.spawnEnv !== undefined ? { spawnEnv: input.spawnEnv } : {}),
  });
  return { registry, plannerAdapter, executorAdapter, reviewerAdapter, ciCalls };
}

function scriptFnFrom(
  src: FakeAdapterScript | ((idx: number) => FakeAdapterScript),
): (idx: number) => FakeAdapterScript {
  return typeof src === "function" ? src : () => src;
}

describe("planner runner", () => {
  test("parses a fenced-json planner response into PlannerOutput", async () => {
    const { registry, plannerAdapter } = buildRegistry({
      planner: { finalAssistantText: fencedJson(SAMPLE_PLAN) },
    });
    const runner = registry.get("planner");
    expect(runner).not.toBeNull();
    const out = await runner?.(
      buildCtx({
        nodeKey: "plan",
        initial: { task: "t", repoContext: "ctx" },
      }),
    );
    expect(out?.ok).toBe(true);
    expect(out?.value).toEqual(SAMPLE_PLAN);
    // Codex subscription cost reporting -> null + unknown.
    expect(out?.costUsd).toBeNull();
    expect(out?.costConfidence).toBe("unknown");
    expect(out?.costSource).toBe("codex-subscription");
    // Sanity: the fake adapter was actually spawned once with the workspace cwd.
    expect(plannerAdapter.spawnCount).toBe(1);
    expect(plannerAdapter.handles[0]?.lastSpawnOpts.cwd).toBe("/tmp/shamu-fake");
    expect(plannerAdapter.handles[0]?.lastSpawnOpts.model).toBe("gpt-5.4");
  });

  test("throws with a clear message when the model omits a json block", async () => {
    const { registry } = buildRegistry({
      planner: { finalAssistantText: "no json block here" },
    });
    const runner = registry.get("planner");
    await expect(
      runner?.(buildCtx({ nodeKey: "plan", initial: { task: "t", repoContext: "ctx" } })),
    ).rejects.toThrow(/no fenced `json` block/);
  });

  test("throws when initial inputs are missing", async () => {
    const { registry } = buildRegistry({
      planner: { finalAssistantText: fencedJson(SAMPLE_PLAN) },
    });
    const runner = registry.get("planner");
    await expect(runner?.(buildCtx({ nodeKey: "plan", initial: { task: "t" } }))).rejects.toThrow(
      /repoContext/,
    );
  });
});

describe("executor runner", () => {
  test("sums cost events from fake Claude adapter as exact + source=vendor", async () => {
    const { registry, executorAdapter } = buildRegistry({
      executor: {
        finalAssistantText: fencedJson(SAMPLE_EXEC),
        costSamples: [
          { usd: 0.12, confidence: "exact", source: "vendor" },
          { usd: 0.03, confidence: "exact", source: "vendor" },
        ],
      },
    });
    const runner = registry.get("executor");
    const out = await runner?.(
      buildCtx({
        nodeKey: "execute",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: { plan: okOutput(SAMPLE_PLAN) },
      }),
    );
    expect(out?.ok).toBe(true);
    expect(out?.value).toEqual(SAMPLE_EXEC);
    expect(out?.costUsd).toBeCloseTo(0.15, 5);
    expect(out?.costConfidence).toBe("exact");
    expect(out?.costSource).toBe("vendor");
    expect(executorAdapter.spawnCount).toBe(1);
    expect(executorAdapter.handles[0]?.lastSpawnOpts.model).toBe("claude-opus-4-7");
  });

  test("reports costConfidence=unknown when no cost events arrive", async () => {
    const { registry } = buildRegistry({
      executor: { finalAssistantText: fencedJson(SAMPLE_EXEC) },
    });
    const runner = registry.get("executor");
    const out = await runner?.(
      buildCtx({
        nodeKey: "execute",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: { plan: okOutput(SAMPLE_PLAN) },
      }),
    );
    expect(out?.ok).toBe(true);
    expect(out?.costUsd).toBeNull();
    expect(out?.costConfidence).toBe("unknown");
  });

  test("throws if the prior planner output is missing from priorOutputs", async () => {
    const { registry } = buildRegistry({
      executor: { finalAssistantText: fencedJson(SAMPLE_EXEC) },
    });
    const runner = registry.get("executor");
    await expect(
      runner?.(buildCtx({ nodeKey: "execute", initial: { task: "t", repoContext: "ctx" } })),
    ).rejects.toThrow(/missing successful 'plan'/);
  });
});

describe("ci runner", () => {
  test("projects a green gate result into a PatchReady CINodeOutput", async () => {
    const { registry, ciCalls } = buildRegistry({
      ciRun: async () => makeGateResult({ status: "green", runId: "run-a" }),
    });
    const runner = registry.get("ci");
    const out = await runner?.(
      buildCtx({
        nodeKey: "ci",
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const value = out?.value as CINodeOutput;
    expect(value.kind).toBe("PatchReady");
    expect(value.runId).toBe("run-a");
    expect(value.summary.status).toBe("green");
    expect(value.reviewerExcerpt).toBeNull();
    expect(out?.costUsd).toBeNull();
    expect(out?.costConfidence).toBe("unknown");
    expect(out?.costSource).toBe("ci-gate");
    expect(ciCalls).toHaveLength(1);
    expect(ciCalls[0]?.cwd).toBe("/tmp/shamu-fake");
  });

  test("projects a red gate result into a CIRed CINodeOutput with an excerpt", async () => {
    const { registry } = buildRegistry({
      ciRun: async () =>
        makeGateResult({ status: "red", runId: "run-b", excerpt: "test X failed: boom" }),
    });
    const runner = registry.get("ci");
    const out = await runner?.(
      buildCtx({
        nodeKey: "ci",
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const value = out?.value as CINodeOutput;
    expect(value.kind).toBe("CIRed");
    expect(value.summary.status).toBe("red");
    expect(value.reviewerExcerpt).toBe("test X failed: boom");
  });

  test("propagates a GateBootError as a non-retriable failed NodeOutput", async () => {
    const { registry } = buildRegistry({
      ciRun: async () => {
        const { GateBootError } = await import("@shamu/ci");
        throw new GateBootError("no GITHUB_REPO resolvable");
      },
    });
    const runner = registry.get("ci");
    const out = await runner?.(
      buildCtx({
        nodeKey: "ci",
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
        },
      }),
    );
    expect(out?.ok).toBe(false);
    expect(out?.error?.message).toMatch(/no GITHUB_REPO/);
    expect(out?.error?.retriable).toBe(false);
    expect(out?.costSource).toBe("ci-gate");
  });
});

describe("reviewer runner", () => {
  test("approve on first pass returns iterationsUsed=1 without re-invoking executor", async () => {
    const { registry, executorAdapter, reviewerAdapter } = buildRegistry({
      reviewer: { finalAssistantText: fencedJson(APPROVE) },
    });
    const runner = registry.get("reviewer");
    const out = await runner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const verdict = out?.value as ReviewerVerdict;
    expect(verdict.verdict).toBe("approve");
    expect(verdict.iterationsUsed).toBe(1);
    expect(reviewerAdapter.spawnCount).toBe(1);
    // Executor was NOT re-invoked on an initial approve.
    expect(executorAdapter.spawnCount).toBe(0);
  });

  test("revise twice then approve -> executor called twice, iterationsUsed=3", async () => {
    const reviewerScripts: FakeAdapterScript[] = [
      { finalAssistantText: fencedJson(REVISE) },
      { finalAssistantText: fencedJson(REVISE) },
      { finalAssistantText: fencedJson(APPROVE) },
    ];
    const executorScripts: FakeAdapterScript[] = [
      { finalAssistantText: fencedJson(SAMPLE_EXEC) },
      { finalAssistantText: fencedJson(SAMPLE_EXEC) },
    ];
    const { registry, executorAdapter, reviewerAdapter } = buildRegistry({
      reviewer: (idx) => {
        const script = reviewerScripts[idx];
        if (!script) throw new Error(`unexpected reviewer spawn #${idx}`);
        return script;
      },
      executor: (idx) => {
        const script = executorScripts[idx];
        if (!script) throw new Error(`unexpected executor spawn #${idx}`);
        return script;
      },
    });
    const runner = registry.get("reviewer");
    const out = await runner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const verdict = out?.value as ReviewerVerdict;
    expect(verdict.verdict).toBe("approve");
    expect(verdict.iterationsUsed).toBe(3);
    expect(reviewerAdapter.spawnCount).toBe(3);
    expect(executorAdapter.spawnCount).toBe(2);
  });

  test("revise until cap -> returns revise with iterationsUsed==maxIterations", async () => {
    const maxIterations = 3;
    const { registry, executorAdapter, reviewerAdapter } = buildRegistry({
      reviewer: { finalAssistantText: fencedJson(REVISE) },
      executor: { finalAssistantText: fencedJson(SAMPLE_EXEC) },
      maxIterations,
    });
    const runner = registry.get("reviewer");
    const out = await runner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const verdict = out?.value as ReviewerVerdict;
    expect(verdict.verdict).toBe("revise");
    expect(verdict.iterationsUsed).toBe(maxIterations);
    expect(reviewerAdapter.spawnCount).toBe(maxIterations);
    // Executor re-invoked once per revise-not-at-cap = maxIterations - 1.
    expect(executorAdapter.spawnCount).toBe(maxIterations - 1);
  });

  test("red CI forces revise even when the reviewer emitted approve", async () => {
    const { registry, reviewerAdapter } = buildRegistry({
      reviewer: { finalAssistantText: fencedJson(APPROVE) },
      maxIterations: 1,
    });
    const runner = registry.get("reviewer");
    const out = await runner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
          ci: ciPriorOutput({
            status: "red",
            excerpt: "tap: tests failed\n  - math breaks\n  - assertion 1 != 2",
          }),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const verdict = out?.value as ReviewerVerdict;
    // The model said approve; the runner auto-rewrote to revise because CI
    // was red. The feedback starts with the [shamu] marker and includes the
    // CI excerpt head.
    expect(verdict.verdict).toBe("revise");
    expect(verdict.feedback).toMatch(/^\[shamu\] reviewer emitted 'approve' against red CI/);
    expect(verdict.feedback).toContain("tap: tests failed");
    expect(verdict.concerns[0]).toMatch(/auto-rewrote verdict/);
    expect(reviewerAdapter.spawnCount).toBe(1);
  });

  test("green CI lets the reviewer approve normally", async () => {
    const { registry } = buildRegistry({
      reviewer: { finalAssistantText: fencedJson(APPROVE) },
    });
    const runner = registry.get("reviewer");
    const out = await runner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
          ci: ciPriorOutput({ status: "green" }),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const verdict = out?.value as ReviewerVerdict;
    expect(verdict.verdict).toBe("approve");
    expect(verdict.iterationsUsed).toBe(1);
  });

  test("internal re-execute loop re-runs CI per iteration", async () => {
    // revise -> re-run executor + CI, approve -> done. That's 2 reviewer
    // spawns + 1 executor re-invocation + 2 ci calls (initial ci priorOutput
    // + one re-run inside the reviewer).
    const reviewerScripts: FakeAdapterScript[] = [
      { finalAssistantText: fencedJson(REVISE) },
      { finalAssistantText: fencedJson(APPROVE) },
    ];
    const ciRuns: Array<"green" | "red"> = [];
    const { registry, executorAdapter, reviewerAdapter, ciCalls } = buildRegistry({
      reviewer: (idx) => {
        const script = reviewerScripts[idx];
        if (!script) throw new Error(`unexpected reviewer spawn #${idx}`);
        return script;
      },
      executor: { finalAssistantText: fencedJson(SAMPLE_EXEC) },
      ciRun: async () => {
        ciRuns.push("green");
        return makeGateResult({ status: "green", runId: `run-${ciRuns.length}` });
      },
    });
    const runner = registry.get("reviewer");
    const out = await runner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
          ci: ciPriorOutput({ status: "green" }),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const verdict = out?.value as ReviewerVerdict;
    expect(verdict.verdict).toBe("approve");
    expect(verdict.iterationsUsed).toBe(2);
    expect(reviewerAdapter.spawnCount).toBe(2);
    expect(executorAdapter.spawnCount).toBe(1);
    // Exactly one CI re-run happened inside the reviewer's internal loop
    // (after the revise-triggered executor re-run). The initial CI was
    // already on the priorOutputs so no run at iteration 1.
    expect(ciCalls).toHaveLength(1);
  });

  test("requires_ci_rerun skips the executor and re-runs CI only", async () => {
    // Reviewer emits requires_ci_rerun on first pass; then green CI and
    // approve on second pass. Executor must NOT be re-invoked.
    const reviewerScripts: FakeAdapterScript[] = [
      {
        finalAssistantText: fencedJson({
          verdict: "requires_ci_rerun",
          feedback: "suspected flake",
          concerns: ["docker boot hung"],
        }),
      },
      { finalAssistantText: fencedJson(APPROVE) },
    ];
    let ciCallIndex = 0;
    const { registry, executorAdapter, reviewerAdapter, ciCalls } = buildRegistry({
      reviewer: (idx) => {
        const script = reviewerScripts[idx];
        if (!script) throw new Error(`unexpected reviewer spawn #${idx}`);
        return script;
      },
      // First ci call on the priorOutputs stub is already red; second ci
      // call (from the reviewer's rerun) is green. The reviewer sees the
      // green result on the second pass and approves.
      ciRun: async () => {
        ciCallIndex += 1;
        return makeGateResult({
          status: ciCallIndex === 1 ? "green" : "green",
          runId: `run-${ciCallIndex}`,
        });
      },
    });
    const runner = registry.get("reviewer");
    const out = await runner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
          // Initial CI was red -> reviewer flags it as a flake.
          ci: ciPriorOutput({ status: "red", excerpt: "docker hung" }),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const verdict = out?.value as ReviewerVerdict;
    expect(verdict.verdict).toBe("approve");
    expect(verdict.iterationsUsed).toBe(2);
    expect(reviewerAdapter.spawnCount).toBe(2);
    // Executor MUST NOT be re-invoked on requires_ci_rerun.
    expect(executorAdapter.spawnCount).toBe(0);
    // Exactly one CI re-run happened inside the reviewer's internal loop.
    expect(ciCalls).toHaveLength(1);
  });

  test("missing CI priorOutput is treated as absent, reviewer still runs", async () => {
    const { registry } = buildRegistry({
      reviewer: { finalAssistantText: fencedJson(APPROVE) },
    });
    const runner = registry.get("reviewer");
    // No `ci` key in priorOutputs -- reviewer proceeds without CI info.
    const out = await runner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const verdict = out?.value as ReviewerVerdict;
    expect(verdict.verdict).toBe("approve");
  });
});

describe("loop-predicate runner", () => {
  test("returns true when reviewer approved", async () => {
    const { registry } = buildRegistry({});
    const runner = registry.get("loop-predicate");
    const verdict: ReviewerVerdict = {
      verdict: "approve",
      feedback: "ok",
      iterationsUsed: 1,
      concerns: [],
    };
    const out = await runner?.(
      buildCtx({
        nodeKey: "loop",
        priorOutputs: { review: okOutput(verdict) },
      }),
    );
    expect(out?.value).toBe(true);
  });

  test("returns true when iterationsUsed hits the cap", async () => {
    const { registry } = buildRegistry({ maxIterations: 2 });
    const runner = registry.get("loop-predicate");
    const verdict: ReviewerVerdict = {
      verdict: "revise",
      feedback: "meh",
      iterationsUsed: 2,
      concerns: [],
    };
    const out = await runner?.(
      buildCtx({
        nodeKey: "loop",
        priorOutputs: { review: okOutput(verdict) },
      }),
    );
    expect(out?.value).toBe(true);
  });

  test("returns true on revise below the cap (reviewer already re-rendered)", async () => {
    // The reviewer runner internally drives the revise->retry loop; by the
    // time the engine reaches the loop predicate, the reviewer's verdict is
    // authoritative, so the predicate always terminates. Returning `false`
    // here would attempt to re-enter the (uninvokable) Loop body and spin.
    const { registry } = buildRegistry({ maxIterations: 5 });
    const runner = registry.get("loop-predicate");
    const verdict: ReviewerVerdict = {
      verdict: "revise",
      feedback: "meh",
      iterationsUsed: 1,
      concerns: [],
    };
    const out = await runner?.(
      buildCtx({
        nodeKey: "loop",
        priorOutputs: { review: okOutput(verdict) },
      }),
    );
    expect(out?.value).toBe(true);
  });

  test("returns true when requires_ci_rerun hits the cap", async () => {
    const { registry } = buildRegistry({ maxIterations: 2 });
    const runner = registry.get("loop-predicate");
    const verdict: ReviewerVerdict = {
      verdict: "requires_ci_rerun",
      feedback: "suspected flake",
      iterationsUsed: 2,
      concerns: [],
    };
    const out = await runner?.(
      buildCtx({
        nodeKey: "loop",
        priorOutputs: { review: okOutput(verdict) },
      }),
    );
    expect(out?.value).toBe(true);
  });

  test("returns true on requires_ci_rerun below the cap (defensive)", async () => {
    const { registry } = buildRegistry({ maxIterations: 5 });
    const runner = registry.get("loop-predicate");
    const verdict: ReviewerVerdict = {
      verdict: "requires_ci_rerun",
      feedback: "flake",
      iterationsUsed: 1,
      concerns: [],
    };
    const out = await runner?.(
      buildCtx({
        nodeKey: "loop",
        priorOutputs: { review: okOutput(verdict) },
      }),
    );
    expect(out?.value).toBe(true);
  });

  test("returns true when no review output is present (defensive)", async () => {
    const { registry } = buildRegistry({});
    const runner = registry.get("loop-predicate");
    const out = await runner?.(buildCtx({ nodeKey: "loop" }));
    expect(out?.value).toBe(true);
    expect(out?.costUsd).toBeNull();
  });
});

describe("spawnEnv passthrough (Phase 8.A egress-broker wiring)", () => {
  const PROXY_ENV = {
    HTTPS_PROXY: "http://127.0.0.1:55123",
    HTTP_PROXY: "http://127.0.0.1:55123",
    NO_PROXY: "127.0.0.1,localhost",
  } as const;

  test("planner runner threads spawnEnv into SpawnOpts.env", async () => {
    const { registry, plannerAdapter } = buildRegistry({
      planner: { finalAssistantText: fencedJson(SAMPLE_PLAN) },
      spawnEnv: PROXY_ENV,
    });
    const runner = registry.get("planner");
    await runner?.(buildCtx({ nodeKey: "plan", initial: { task: "t", repoContext: "ctx" } }));
    expect(plannerAdapter.handles[0]?.lastSpawnOpts.env).toEqual(PROXY_ENV);
  });

  test("executor runner threads spawnEnv into SpawnOpts.env", async () => {
    const { registry, executorAdapter } = buildRegistry({
      executor: { finalAssistantText: fencedJson(SAMPLE_EXEC) },
      spawnEnv: PROXY_ENV,
    });
    const runner = registry.get("executor");
    await runner?.(
      buildCtx({
        nodeKey: "execute",
        initial: { task: "t" },
        priorOutputs: {
          plan: {
            ok: true,
            value: SAMPLE_PLAN,
            costUsd: null,
            costConfidence: "unknown",
            costSource: "codex-subscription",
          },
        },
      }),
    );
    expect(executorAdapter.handles[0]?.lastSpawnOpts.env).toEqual(PROXY_ENV);
  });

  test("reviewer runner threads spawnEnv into SpawnOpts.env", async () => {
    const { registry, reviewerAdapter } = buildRegistry({
      reviewer: { finalAssistantText: fencedJson(APPROVE) },
      spawnEnv: PROXY_ENV,
    });
    const runner = registry.get("reviewer");
    await runner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t" },
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
          ci: ciPriorOutput({ status: "green" }),
        },
      }),
    );
    expect(reviewerAdapter.handles[0]?.lastSpawnOpts.env).toEqual(PROXY_ENV);
  });

  test("when spawnEnv is omitted, SpawnOpts.env is undefined (no-op default)", async () => {
    const { registry, plannerAdapter } = buildRegistry({
      planner: { finalAssistantText: fencedJson(SAMPLE_PLAN) },
    });
    const runner = registry.get("planner");
    await runner?.(buildCtx({ nodeKey: "plan", initial: { task: "t", repoContext: "ctx" } }));
    expect(plannerAdapter.handles[0]?.lastSpawnOpts.env).toBeUndefined();
  });
});
