/**
 * Runner registrations for the plan -> execute -> review flow.
 *
 * Five runners land in the registry:
 *   - "planner"        -- Codex adapter (GPT-5.4) producing a plan
 *   - "executor"       -- Claude adapter (Opus 4.7) applying edits
 *   - "ci"             -- @shamu/ci gate wrapping @redwoodjs/agent-ci; emits a
 *                         CINodeOutput the reviewer consumes.
 *   - "reviewer"       -- Codex adapter (GPT-5.4) rendering approve/revise/
 *                         requires_ci_rerun. ALSO drives the revise->executor
 *                         re-run loop internally, re-running CI each pass.
 *   - "loop-predicate" -- zero-cost terminator; returns `true` when the
 *                         reviewer verdict is approve or the iteration cap
 *                         is hit, `false` otherwise.
 *
 * Test-only overrides:
 *   `RegisterRunnersOptions.__adapterOverride` injects fake adapters.
 *   `RegisterRunnersOptions.__ciRunOverride` injects a scripted CI runner.
 *   The `__`-prefixed keys are documented as NOT part of the public contract;
 *   4.C's loader ignores them.
 *
 * Cost semantics (PLAN.md § 7 + T17):
 *   - Claude declares `costReporting: "native"`; the runner sums `cost`
 *     events' `usd` fields and stamps `confidence: "exact" | "estimate"` +
 *     `source: "vendor"` onto the NodeOutput. We trust the adapter-level
 *     stamping because the orchestrator owns it via `stampCostEventFromCapability`.
 *     The runner does NOT override the adapter's per-event confidence; it
 *     aggregates.
 *   - Codex declares `costReporting: "subscription"`; the runner records
 *     `costUsd: null`, `confidence: "unknown"`, `source: "codex-subscription"`.
 *     A future vendor SDK that surfaces per-run USD would flip Codex's
 *     capability manifest to `"native"` and this runner would start getting
 *     non-null samples without code changes here.
 *   - CI is not a model call: `costUsd: null`, `confidence: "unknown"`,
 *     `source: "ci-gate"`.
 */

import { type ClaudeAdapterOptions, createClaudeAdapter } from "@shamu/adapter-claude";
import { CodexAdapter, type CodexAdapterOptions } from "@shamu/adapter-codex";
import type {
  AgentAdapter,
  AgentEvent,
  AgentHandle,
  SpawnOpts,
  UserTurn,
} from "@shamu/adapters-base";
import type { GateResult, RunGateOptions } from "@shamu/ci";
import { runGate as defaultRunGate, GateBootError } from "@shamu/ci";
import type { RunnerContext, RunnerRegistry } from "@shamu/core-flow/runners";
import type { NodeCostConfidence, NodeOutput } from "@shamu/core-flow/types";
import { newRunId, type RunId } from "@shamu/shared/ids";
import {
  DEFAULT_EXECUTOR_MODEL,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PLANNER_MODEL,
  DEFAULT_REVIEWER_MODEL,
} from "./config.ts";
import {
  buildExecutorPrompt,
  buildPlannerPrompt,
  buildReviewerPrompt,
  JSON_BLOCK_LANG,
  type ReviewerPromptCI,
} from "./prompts.ts";
import {
  type CINodeOutput,
  CINodeOutputSchema,
  type ExecutorOutput,
  ExecutorOutputSchema,
  type PlannerOutput,
  PlannerOutputSchema,
  ReviewerModelOutputSchema,
  type ReviewerVerdict,
} from "./schemas.ts";

// --- public options -------------------------------------------------------

/**
 * Caller-supplied CI configuration forwarded to `@shamu/ci`'s `runGate`. All
 * fields are optional; reasonable defaults are inherited from `runGate`
 * itself. `cwd` is NOT accepted here -- the `ci` runner always spawns agent-ci
 * with `opts.workspaceCwd` so the gate sees the executor's worktree.
 */
export interface RegisterRunnersCIOptions {
  readonly githubRepo?: string;
  readonly bin?: string;
  readonly workflow?: string;
  readonly all?: boolean;
  readonly extraArgs?: readonly string[];
  readonly workingDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly pauseOnFailure?: boolean;
}

export interface RegisterRunnersOptions {
  readonly anthropicCliPath?: string;
  readonly codexCliPath?: string;
  /** Where the executor's edits land; every adapter spawn uses this cwd. */
  readonly workspaceCwd: string;
  readonly maxIterations?: number;
  readonly plannerModel?: string;
  readonly executorModel?: string;
  readonly reviewerModel?: string;
  /** CI gate configuration forwarded to `@shamu/ci`. */
  readonly ci?: RegisterRunnersCIOptions;
  /**
   * Extra env vars forwarded into every adapter spawn the canonical flow
   * makes. Phase 8.A's Linear daemon uses this to thread
   * `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` from the per-run egress broker
   * into each runner's subprocess. Empty-string values delete a key.
   * When omitted, the flow's behavior is identical to the pre-Phase-8
   * state (no proxy set).
   */
  readonly spawnEnv?: Readonly<Record<string, string>>;
  /**
   * Test-only adapter factory override. Present so unit tests can inject
   * scripted adapters without reaching into `@shamu/adapter-{claude,codex}`.
   * The `__`-prefix + this doc comment are the full contract: 4.C's loader
   * does NOT forward this, and it is not exported from the package's
   * `index.ts`.
   */
  readonly __adapterOverride?: AdapterOverride;
  /**
   * Test-only CI runner override. Accepts the same `RunGateOptions` the
   * real `runGate` would have received and returns a scripted `GateResult`.
   * Unit tests use this to exercise red/green/boot-error paths without
   * spawning agent-ci.
   */
  readonly __ciRunOverride?: CIRunOverride;
}

/**
 * Injection seam for tests. Each factory accepts the role-specific SpawnOpts
 * the runner would have synthesized and returns a ready `AgentAdapter`.
 */
export interface AdapterOverride {
  readonly plannerAdapter: () => AgentAdapter;
  readonly executorAdapter: () => AgentAdapter;
  readonly reviewerAdapter: () => AgentAdapter;
}

/** Test-only CI override signature; mirrors `@shamu/ci`'s `runGate`. */
export type CIRunOverride = (opts: RunGateOptions) => Promise<GateResult>;

// --- registration --------------------------------------------------------

export function registerRunners(registry: RunnerRegistry, opts: RegisterRunnersOptions): void {
  if (typeof opts.workspaceCwd !== "string" || opts.workspaceCwd.length === 0) {
    throw new TypeError("registerRunners: workspaceCwd must be a non-empty string");
  }
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new TypeError("registerRunners: maxIterations must be a positive integer");
  }
  const plannerModel = opts.plannerModel ?? DEFAULT_PLANNER_MODEL;
  const executorModel = opts.executorModel ?? DEFAULT_EXECUTOR_MODEL;
  const reviewerModel = opts.reviewerModel ?? DEFAULT_REVIEWER_MODEL;

  // Iteration counter keyed on flowRunId. A closure-local Map means two
  // concurrent flow runs sharing one registry don't fight over the counter.
  // We never delete entries: flow runs end; the registry outlives them; the
  // memory impact is bounded by live flowRunIds.
  const iterationCounters = new Map<string, number>();

  const plannerAdapter = (): AgentAdapter =>
    opts.__adapterOverride?.plannerAdapter() ?? buildCodexAdapter();
  const executorAdapter = (): AgentAdapter =>
    opts.__adapterOverride?.executorAdapter() ?? buildClaudeAdapter();
  const reviewerAdapter = (): AgentAdapter =>
    opts.__adapterOverride?.reviewerAdapter() ?? buildCodexAdapter();

  const ciRun: CIRunOverride = opts.__ciRunOverride ?? defaultRunGate;

  registry.register("planner", async (ctx) => {
    const input: PlannerRunnerInput = {
      ctx,
      adapterFactory: plannerAdapter,
      model: plannerModel,
      workspaceCwd: opts.workspaceCwd,
      ...(opts.codexCliPath !== undefined ? { codexCliPath: opts.codexCliPath } : {}),
      ...(opts.spawnEnv !== undefined ? { spawnEnv: opts.spawnEnv } : {}),
    };
    return runPlanner(input);
  });

  registry.register("executor", async (ctx) => {
    const input: ExecutorRunnerInput = {
      ctx,
      adapterFactory: executorAdapter,
      model: executorModel,
      workspaceCwd: opts.workspaceCwd,
      ...(opts.anthropicCliPath !== undefined ? { anthropicCliPath: opts.anthropicCliPath } : {}),
      ...(opts.spawnEnv !== undefined ? { spawnEnv: opts.spawnEnv } : {}),
    };
    return runExecutor(input);
  });

  registry.register("ci", async (ctx) => {
    return runCi({
      ciRun,
      workspaceCwd: opts.workspaceCwd,
      ...(opts.ci !== undefined ? { ciOptions: opts.ci } : {}),
      signal: ctx.signal,
    });
  });

  registry.register("reviewer", async (ctx) => {
    const input: ReviewerRunnerInput = {
      ctx,
      reviewerAdapterFactory: reviewerAdapter,
      executorAdapterFactory: executorAdapter,
      reviewerModel,
      executorModel,
      workspaceCwd: opts.workspaceCwd,
      maxIterations,
      iterationCounters,
      ciRun,
      ...(opts.codexCliPath !== undefined ? { codexCliPath: opts.codexCliPath } : {}),
      ...(opts.anthropicCliPath !== undefined ? { anthropicCliPath: opts.anthropicCliPath } : {}),
      ...(opts.ci !== undefined ? { ciOptions: opts.ci } : {}),
      ...(opts.spawnEnv !== undefined ? { spawnEnv: opts.spawnEnv } : {}),
    };
    return runReviewer(input);
  });

  registry.register("loop-predicate", async (ctx) => {
    return runLoopPredicate({ ctx, maxIterations });
  });
}

function buildClaudeAdapter(options?: ClaudeAdapterOptions): AgentAdapter {
  return createClaudeAdapter(options);
}

function buildCodexAdapter(options?: CodexAdapterOptions): AgentAdapter {
  return new CodexAdapter(options);
}

// --- planner runner -------------------------------------------------------

interface PlannerRunnerInput {
  readonly ctx: RunnerContext;
  readonly adapterFactory: () => AgentAdapter;
  readonly model: string;
  readonly workspaceCwd: string;
  readonly codexCliPath?: string;
  readonly spawnEnv?: Readonly<Record<string, string>>;
}

async function runPlanner(input: PlannerRunnerInput): Promise<NodeOutput> {
  const { ctx } = input;
  const { task, repoContext } = extractInitialStrings(ctx, ["task", "repoContext"]);
  const prompt = buildPlannerPrompt({ task, repoContext });

  const adapter = input.adapterFactory();
  const spawnOpts = makeSpawnOpts({
    model: input.model,
    workspaceCwd: input.workspaceCwd,
    ...(input.codexCliPath !== undefined ? { vendorCliPath: input.codexCliPath } : {}),
    ...(input.spawnEnv !== undefined ? { env: input.spawnEnv } : {}),
  });
  const collected = await runSingleTurn({
    adapter,
    spawnOpts,
    systemPreamble: prompt.system,
    userText: prompt.user,
    signal: ctx.signal,
  });

  const parsed = parseLastJsonBlock(collected.finalText, PlannerOutputSchema);
  // Planner uses Codex -> costReporting: "subscription" -> null cost.
  return okOutput({
    value: parsed satisfies PlannerOutput,
    costUsd: null,
    costConfidence: "unknown",
    costSource: "codex-subscription",
  });
}

// --- executor runner ------------------------------------------------------

interface ExecutorRunnerInput {
  readonly ctx: RunnerContext;
  readonly adapterFactory: () => AgentAdapter;
  readonly model: string;
  readonly workspaceCwd: string;
  readonly anthropicCliPath?: string;
  readonly spawnEnv?: Readonly<Record<string, string>>;
  /** Set when the reviewer re-invokes the executor for another iteration. */
  readonly reviewerFeedback?: string;
  readonly priorExecutorNotes?: string;
  /** Optional plan override (used by the reviewer re-run path). */
  readonly planOverride?: PlannerOutput;
  /** Optional task override (used by the reviewer re-run path). */
  readonly taskOverride?: string;
}

interface ExecutorRunnerResult {
  readonly output: NodeOutput;
  readonly executorOutput: ExecutorOutput;
}

async function runExecutor(input: ExecutorRunnerInput): Promise<NodeOutput> {
  const result = await invokeExecutor(input);
  return result.output;
}

async function invokeExecutor(input: ExecutorRunnerInput): Promise<ExecutorRunnerResult> {
  const { ctx } = input;
  const task = input.taskOverride ?? extractInitialStrings(ctx, ["task"]).task;
  const plan = input.planOverride ?? extractPriorPlannerOutput(ctx);
  const promptInput: {
    task: string;
    plan: PlannerOutput;
    reviewerFeedback?: string;
    priorNotes?: string;
  } = { task, plan };
  if (input.reviewerFeedback !== undefined) promptInput.reviewerFeedback = input.reviewerFeedback;
  if (input.priorExecutorNotes !== undefined) promptInput.priorNotes = input.priorExecutorNotes;
  const prompt = buildExecutorPrompt(promptInput);

  const adapter = input.adapterFactory();
  const spawnOpts = makeSpawnOpts({
    model: input.model,
    workspaceCwd: input.workspaceCwd,
    ...(input.anthropicCliPath !== undefined ? { vendorCliPath: input.anthropicCliPath } : {}),
    ...(input.spawnEnv !== undefined ? { env: input.spawnEnv } : {}),
  });
  const collected = await runSingleTurn({
    adapter,
    spawnOpts,
    systemPreamble: prompt.system,
    userText: prompt.user,
    signal: ctx.signal,
  });

  const parsed = parseLastJsonBlock(collected.finalText, ExecutorOutputSchema);
  const costSummary = summarizeCost(collected.costEvents);
  const output = okOutput({
    value: parsed satisfies ExecutorOutput,
    costUsd: costSummary.totalUsd,
    costConfidence: costSummary.confidence,
    // Claude declares `native` cost reporting; the adapter-level stamper
    // has already set source="vendor" on each event. We preserve that
    // label here for the node-level aggregate so the cost roll-up sink
    // reports the right provenance.
    costSource: "vendor",
  });
  return { output, executorOutput: parsed };
}

// --- ci runner ------------------------------------------------------------

interface CiRunnerInput {
  readonly ciRun: CIRunOverride;
  readonly workspaceCwd: string;
  readonly ciOptions?: RegisterRunnersCIOptions;
  readonly signal: AbortSignal;
}

interface CiRunnerResult {
  readonly output: NodeOutput;
  readonly ciOutput: CINodeOutput | null;
}

async function runCi(input: CiRunnerInput): Promise<NodeOutput> {
  const result = await invokeCiGate(input);
  return result.output;
}

/**
 * Shared call site for the `ci` runner AND the reviewer runner's internal
 * re-run loop. Factored out so both surfaces send the same options and
 * interpret the result identically.
 */
async function invokeCiGate(input: CiRunnerInput): Promise<CiRunnerResult> {
  const gateOpts = buildGateOptions(input);
  let result: GateResult;
  try {
    result = await input.ciRun(gateOpts);
  } catch (cause) {
    // GateBootError or anything else blowing up before we could spawn is a
    // failed NodeOutput. We deliberately do NOT downgrade to a synthetic
    // green summary -- the reviewer must see that CI never actually ran.
    const message = cause instanceof Error ? cause.message : String(cause);
    const retriable = !(cause instanceof GateBootError);
    return {
      output: {
        ok: false,
        value: null,
        costUsd: null,
        costConfidence: "unknown",
        costSource: "ci-gate",
        error: { message: `ci gate boot failed: ${message}`, retriable },
      },
      ciOutput: null,
    };
  }

  if (result.domainEvent === null || result.summary === null) {
    // Ran, but we couldn't derive a summary (run dir missing, parse failure).
    // Treat this as a retriable failed node so the flow surfaces it rather
    // than silently approving.
    return {
      output: {
        ok: false,
        value: null,
        costUsd: null,
        costConfidence: "unknown",
        costSource: "ci-gate",
        error: {
          message: `ci gate produced no summary (exitCode=${result.exitCode}, runDir=${result.runDir ?? "null"})`,
          retriable: true,
        },
      },
      ciOutput: null,
    };
  }

  const ev = result.domainEvent;
  const ciOutput: CINodeOutput = {
    kind: ev.kind,
    runId: ev.runId,
    summary: ev.summary,
    reviewerExcerpt: ev.kind === "CIRed" ? ev.reviewerExcerpt : null,
  };
  return {
    output: okOutput({
      value: ciOutput,
      costUsd: null,
      costConfidence: "unknown",
      costSource: "ci-gate",
    }),
    ciOutput,
  };
}

function buildGateOptions(input: CiRunnerInput): RunGateOptions {
  const ci = input.ciOptions;
  const out: RunGateOptions = {
    cwd: input.workspaceCwd,
    signal: input.signal,
  };
  if (ci === undefined) return out;
  if (ci.githubRepo !== undefined) out.githubRepo = ci.githubRepo;
  if (ci.bin !== undefined) out.bin = ci.bin;
  if (ci.workflow !== undefined) out.workflow = ci.workflow;
  if (ci.all !== undefined) out.all = ci.all;
  if (ci.extraArgs !== undefined) out.extraArgs = [...ci.extraArgs];
  if (ci.workingDir !== undefined) out.workingDir = ci.workingDir;
  if (ci.env !== undefined) out.env = { ...ci.env };
  if (ci.pauseOnFailure !== undefined) out.pauseOnFailure = ci.pauseOnFailure;
  return out;
}

// --- reviewer runner ------------------------------------------------------

interface ReviewerRunnerInput {
  readonly ctx: RunnerContext;
  readonly reviewerAdapterFactory: () => AgentAdapter;
  readonly executorAdapterFactory: () => AgentAdapter;
  readonly reviewerModel: string;
  readonly executorModel: string;
  readonly workspaceCwd: string;
  readonly codexCliPath?: string;
  readonly anthropicCliPath?: string;
  readonly spawnEnv?: Readonly<Record<string, string>>;
  readonly maxIterations: number;
  readonly iterationCounters: Map<string, number>;
  readonly ciRun: CIRunOverride;
  readonly ciOptions?: RegisterRunnersCIOptions;
}

async function runReviewer(input: ReviewerRunnerInput): Promise<NodeOutput> {
  const { ctx } = input;
  const counterKey = String(ctx.flowRunId);
  if (input.iterationCounters.has(counterKey)) {
    // Defensive: a second reviewer invocation within the same flow run
    // should only happen via the internal re-run loop, never by the engine
    // re-entering this runner. If this fires, it's a contract bug.
    throw new Error(`reviewer runner: iteration counter already set for flowRunId=${counterKey}`);
  }
  input.iterationCounters.set(counterKey, 1);

  const task = extractInitialStrings(ctx, ["task"]).task;
  const plan = extractPriorPlannerOutput(ctx);
  let execution = extractPriorExecutorOutput(ctx);
  let ciOutput = extractPriorCiOutput(ctx);

  let iteration = 1;
  let verdict: ReviewerVerdict | null = null;

  // The reviewer itself is a Codex adapter, so its cost is null + unknown
  // per Codex's declared `costReporting: "subscription"`. We do not surface
  // review-loop costs on the reviewer's NodeOutput; the executor's
  // NodeOutput carries Claude's exact-cost sum, which is what the budget
  // sink cares about anyway.

  while (iteration <= input.maxIterations) {
    input.iterationCounters.set(counterKey, iteration);
    const renderInput: RenderVerdictInput = {
      reviewerAdapterFactory: input.reviewerAdapterFactory,
      reviewerModel: input.reviewerModel,
      workspaceCwd: input.workspaceCwd,
      signal: ctx.signal,
      task,
      plan,
      execution,
      iteration,
      ci: ciOutput,
      ...(input.codexCliPath !== undefined ? { codexCliPath: input.codexCliPath } : {}),
      ...(input.spawnEnv !== undefined ? { spawnEnv: input.spawnEnv } : {}),
    };
    verdict = await renderReviewerVerdict(renderInput);

    if (verdict.verdict === "approve") break;
    if (iteration >= input.maxIterations) break;

    // Below-cap branches: either a logic fix (revise -> re-run executor +
    // CI) or a suspected flake (requires_ci_rerun -> re-run CI only). In
    // both cases we do NOT bump the counter for the CI re-run itself; CI
    // is not an iteration.
    if (verdict.verdict === "revise") {
      iteration += 1;
      const reinvokeInput: ExecutorRunnerInput = {
        ctx,
        adapterFactory: input.executorAdapterFactory,
        model: input.executorModel,
        workspaceCwd: input.workspaceCwd,
        reviewerFeedback: verdict.feedback,
        priorExecutorNotes: execution.notes,
        planOverride: plan,
        taskOverride: task,
        ...(input.anthropicCliPath !== undefined
          ? { anthropicCliPath: input.anthropicCliPath }
          : {}),
        ...(input.spawnEnv !== undefined ? { spawnEnv: input.spawnEnv } : {}),
      };
      const reinvoked = await invokeExecutor(reinvokeInput);
      execution = reinvoked.executorOutput;
      ciOutput = await rerunCiForIteration(input, ctx.signal);
      continue;
    }

    // requires_ci_rerun: skip the executor, re-run CI only.
    iteration += 1;
    ciOutput = await rerunCiForIteration(input, ctx.signal);
  }

  if (verdict === null) {
    throw new Error("reviewer runner: no verdict rendered (maxIterations misconfigured?)");
  }

  return okOutput({
    value: {
      verdict: verdict.verdict,
      feedback: verdict.feedback,
      iterationsUsed: iteration,
      concerns: verdict.concerns,
    } satisfies ReviewerVerdict,
    costUsd: null,
    costConfidence: "unknown",
    costSource: "codex-subscription",
  });
}

/**
 * Re-invoke the CI gate using the same shared helper the `ci` runner uses.
 * If CI fails to produce an output (boot failure, parse failure), we keep
 * `null` so the next reviewer render sees the absence explicitly rather than
 * a stale result.
 */
async function rerunCiForIteration(
  input: ReviewerRunnerInput,
  signal: AbortSignal,
): Promise<CINodeOutput | null> {
  const result = await invokeCiGate({
    ciRun: input.ciRun,
    workspaceCwd: input.workspaceCwd,
    signal,
    ...(input.ciOptions !== undefined ? { ciOptions: input.ciOptions } : {}),
  });
  return result.ciOutput;
}

interface RenderVerdictInput {
  readonly reviewerAdapterFactory: () => AgentAdapter;
  readonly reviewerModel: string;
  readonly workspaceCwd: string;
  readonly codexCliPath?: string;
  readonly spawnEnv?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly task: string;
  readonly plan: PlannerOutput;
  readonly execution: ExecutorOutput;
  readonly iteration: number;
  readonly ci: CINodeOutput | null;
}

async function renderReviewerVerdict(input: RenderVerdictInput): Promise<ReviewerVerdict> {
  const ciPrompt: ReviewerPromptCI | undefined =
    input.ci !== null
      ? {
          status: input.ci.summary.status,
          excerpt: input.ci.reviewerExcerpt,
        }
      : undefined;
  const prompt = buildReviewerPrompt({
    task: input.task,
    plan: input.plan,
    execution: input.execution,
    ...(ciPrompt !== undefined ? { ci: ciPrompt } : {}),
  });
  const adapter = input.reviewerAdapterFactory();
  const spawnOpts = makeSpawnOpts({
    model: input.reviewerModel,
    workspaceCwd: input.workspaceCwd,
    ...(input.codexCliPath !== undefined ? { vendorCliPath: input.codexCliPath } : {}),
    ...(input.spawnEnv !== undefined ? { env: input.spawnEnv } : {}),
  });
  const collected = await runSingleTurn({
    adapter,
    spawnOpts,
    systemPreamble: prompt.system,
    userText: prompt.user,
    signal: input.signal,
  });
  const parsed = parseLastJsonBlock(collected.finalText, ReviewerModelOutputSchema);

  // Defense-in-depth: the system prompt forbids approve-on-red, but a model
  // may ignore it. Override to revise and prepend a synthetic concern so the
  // downstream sink sees the auto-rewrite. The original feedback is
  // preserved; we wrap it with a marker.
  if (parsed.verdict === "approve" && input.ci?.summary.status === "red") {
    const excerptHead = (input.ci.reviewerExcerpt ?? "").split("\n").slice(0, 3).join("\n");
    const syntheticFeedback = `[shamu] reviewer emitted 'approve' against red CI; forced to revise. CI summary follows: ${excerptHead}\n\n${parsed.feedback}`;
    return {
      verdict: "revise",
      feedback: syntheticFeedback,
      concerns: [
        "[shamu] auto-rewrote verdict: approve against red CI is not permitted",
        ...parsed.concerns,
      ],
      iterationsUsed: input.iteration,
    };
  }

  return {
    verdict: parsed.verdict,
    feedback: parsed.feedback,
    concerns: parsed.concerns,
    iterationsUsed: input.iteration,
  };
}

// --- loop predicate -------------------------------------------------------

interface LoopPredicateInput {
  readonly ctx: RunnerContext;
  readonly maxIterations: number;
}

async function runLoopPredicate(input: LoopPredicateInput): Promise<NodeOutput> {
  const { ctx } = input;
  const review = ctx.priorOutputs["review" as keyof typeof ctx.priorOutputs];
  if (!review) {
    // No prior review output means the reviewer node failed or was skipped.
    // Terminate the loop so the engine moves on; the reviewer's failure
    // already surfaced through its own NodeFailed event.
    return okOutput({
      value: true,
      costUsd: null,
      costConfidence: "unknown",
      costSource: "flow-internal",
    });
  }
  const value = review.value as ReviewerVerdict | undefined;
  const approved = value?.verdict === "approve";
  const iterationsUsed = typeof value?.iterationsUsed === "number" ? value.iterationsUsed : 0;
  const hitCap = iterationsUsed >= input.maxIterations;
  // Both revise and requires_ci_rerun are below-cap cases the reviewer
  // already handled internally; at the predicate we always terminate (true)
  // because the reviewer's final verdict is authoritative -- there is no
  // engine-level re-execution to gate.
  return okOutput({
    value:
      approved || hitCap || value?.verdict === "revise" || value?.verdict === "requires_ci_rerun",
    costUsd: null,
    costConfidence: "unknown",
    costSource: "flow-internal",
  });
}

// --- shared adapter plumbing ---------------------------------------------

interface SingleTurnInput {
  readonly adapter: AgentAdapter;
  readonly spawnOpts: SpawnOpts;
  readonly systemPreamble: string;
  readonly userText: string;
  readonly signal: AbortSignal;
}

interface CollectedTurn {
  readonly finalText: string;
  readonly costEvents: readonly AgentEvent[];
  readonly patches: readonly AgentEvent[];
}

/**
 * Spawn the adapter, push one user turn, drain events until `turn_end` or
 * `session_end` or the iterable completes, and shut down cleanly. This is
 * the single choke point that calls the vendor; both planner/executor/
 * reviewer share it so behavior under failure is uniform.
 *
 * The adapter is responsible for redaction + cost stamping; we aggregate
 * post-redaction events and extract the final assistant message.
 */
async function runSingleTurn(input: SingleTurnInput): Promise<CollectedTurn> {
  let handle: AgentHandle | null = null;
  const costs: AgentEvent[] = [];
  const patches: AgentEvent[] = [];
  let finalText = "";
  try {
    handle = await input.adapter.spawn(input.spawnOpts);
    const userTurn: UserTurn = {
      text: `${input.systemPreamble}\n\n${input.userText}`,
    };
    await handle.send(userTurn);

    for await (const ev of handle.events) {
      if (input.signal.aborted) break;
      if (ev.kind === "assistant_message") {
        finalText = ev.text;
      } else if (ev.kind === "cost") {
        costs.push(ev);
      } else if (ev.kind === "patch_applied") {
        patches.push(ev);
      } else if (ev.kind === "turn_end" || ev.kind === "session_end") {
        // Treat the first turn_end as the close of our single turn. The
        // session_end is a belt-and-braces exit for adapters that skip
        // turn_end entirely.
        break;
      } else if (ev.kind === "error" && ev.fatal) {
        throw new Error(`adapter error: ${ev.message}`);
      }
    }
  } finally {
    if (handle !== null) {
      try {
        await handle.shutdown("flow-runner-complete");
      } catch {
        // Shutdown failures are logged by the adapter; nothing actionable
        // here. A stuck handle would manifest as the outer AbortSignal
        // firing on timeout; we do not re-throw.
      }
    }
  }
  if (finalText.length === 0) {
    throw new Error("adapter produced no final assistant_message");
  }
  return { finalText, costEvents: costs, patches };
}

function makeSpawnOpts(input: {
  readonly model: string;
  readonly workspaceCwd: string;
  readonly vendorCliPath?: string;
  readonly env?: Readonly<Record<string, string>>;
}): SpawnOpts {
  const runId: RunId = newRunId();
  const opts: {
    runId: RunId;
    cwd: string;
    model: string;
    vendorCliPath?: string;
    env?: Readonly<Record<string, string>>;
  } = {
    runId,
    cwd: input.workspaceCwd,
    model: input.model,
  };
  if (input.vendorCliPath !== undefined) opts.vendorCliPath = input.vendorCliPath;
  if (input.env !== undefined) opts.env = input.env;
  return opts;
}

// --- output + parsing helpers --------------------------------------------

interface OkOutputInput {
  readonly value: unknown;
  readonly costUsd: number | null;
  readonly costConfidence: NodeCostConfidence;
  readonly costSource: string;
}

function okOutput(input: OkOutputInput): NodeOutput {
  return {
    ok: true,
    value: input.value,
    costUsd: input.costUsd,
    costConfidence: input.costConfidence,
    costSource: input.costSource,
  };
}

interface CostSummary {
  readonly totalUsd: number | null;
  readonly confidence: NodeCostConfidence;
}

function summarizeCost(events: readonly AgentEvent[]): CostSummary {
  let total = 0;
  let sawNumber = false;
  let sawExact = false;
  let sawEstimate = false;
  let sawUnknown = false;
  for (const ev of events) {
    if (ev.kind !== "cost") continue;
    if (ev.usd !== null && Number.isFinite(ev.usd)) {
      total += ev.usd;
      sawNumber = true;
    }
    if (ev.confidence === "exact") sawExact = true;
    else if (ev.confidence === "estimate") sawEstimate = true;
    else sawUnknown = true;
  }
  const confidence: NodeCostConfidence =
    sawExact && !sawEstimate
      ? "exact"
      : sawEstimate
        ? "estimate"
        : sawUnknown
          ? "unknown"
          : "unknown";
  return {
    totalUsd: sawNumber ? total : null,
    confidence,
  };
}

/**
 * Extract a set of required string values from the engine's `initial`
 * input bundle. Throws with a clear message rather than returning
 * undefined so a misconfigured caller trips at runner-entry, not deeper
 * inside prompt assembly.
 */
function extractInitialStrings<K extends string>(
  ctx: RunnerContext,
  keys: readonly K[],
): Record<K, string> {
  const initialRaw = (ctx.inputs as { initial?: Record<string, unknown> }).initial;
  if (initialRaw === undefined || initialRaw === null || typeof initialRaw !== "object") {
    throw new Error("runner: RunnerContext.inputs.initial is missing");
  }
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const v = (initialRaw as Record<string, unknown>)[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`runner: initial input '${key}' must be a non-empty string`);
    }
    out[key] = v;
  }
  return out;
}

function extractPriorPlannerOutput(ctx: RunnerContext): PlannerOutput {
  const prior = ctx.priorOutputs["plan" as keyof typeof ctx.priorOutputs];
  if (!prior || prior.ok === false) {
    throw new Error("runner: missing successful 'plan' output in priorOutputs");
  }
  const parsed = PlannerOutputSchema.safeParse(prior.value);
  if (!parsed.success) {
    throw new Error(
      `runner: prior 'plan' output fails PlannerOutputSchema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function extractPriorExecutorOutput(ctx: RunnerContext): ExecutorOutput {
  const prior = ctx.priorOutputs["execute" as keyof typeof ctx.priorOutputs];
  if (!prior || prior.ok === false) {
    throw new Error("runner: missing successful 'execute' output in priorOutputs");
  }
  const parsed = ExecutorOutputSchema.safeParse(prior.value);
  if (!parsed.success) {
    throw new Error(
      `runner: prior 'execute' output fails ExecutorOutputSchema: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Extract the prior `ci` node's output. Unlike the planner/executor
 * extractors, a missing/invalid CI output is not fatal: the reviewer proceeds
 * without CI context (preserves defensive behavior for smoke tests + flows
 * that wire the reviewer without CI).
 */
function extractPriorCiOutput(ctx: RunnerContext): CINodeOutput | null {
  const prior = ctx.priorOutputs["ci" as keyof typeof ctx.priorOutputs];
  if (!prior || prior.ok === false) return null;
  const parsed = CINodeOutputSchema.safeParse(prior.value);
  if (!parsed.success) return null;
  // The schema validates the fields the reviewer depends on + uses
  // passthrough for the rest of `summary`. The runtime shape is the same
  // CIRunSummary the `ci` runner produced -- re-using the original reference
  // preserves type fidelity for downstream consumers.
  return prior.value as CINodeOutput;
}

/**
 * Extract the LAST fenced ```json``` block from a model's final assistant
 * message and validate it against the schema. Regex is deliberate: models
 * often include explanatory fenced blocks earlier; the final block is the
 * one that reflects the model's final judgment.
 */
export function parseLastJsonBlock<T>(
  text: string,
  schema: {
    safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: Error };
  },
): T {
  // `[\s\S]*?` is the explicit "any char including newline" non-greedy match
  // since the `s` flag is not universally available on all runtime regex
  // engines we care about. The outer `g` lets us enumerate every block;
  // we take the last.
  const blockRegex = new RegExp(`\`\`\`${JSON_BLOCK_LANG}\\s*\\n([\\s\\S]*?)\\n\`\`\``, "g");
  const matches: string[] = [];
  for (const m of text.matchAll(blockRegex)) {
    const body = m[1];
    if (typeof body === "string") matches.push(body);
  }
  const last = matches.at(-1);
  if (last === undefined) {
    throw new Error(`runner: no fenced \`${JSON_BLOCK_LANG}\` block found in model output`);
  }
  let data: unknown;
  try {
    data = JSON.parse(last);
  } catch (cause) {
    throw new Error(
      `runner: fenced \`${JSON_BLOCK_LANG}\` block is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`runner: schema violation on fenced json block: ${parsed.error.message}`);
  }
  return parsed.data;
}
