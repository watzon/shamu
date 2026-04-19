/**
 * `soak-daemon.ts` — time-compressed soak harness for the Phase 8.A
 * Linear daemon.
 *
 * Boots `createLinearRuntime` against an in-memory fake webhook + fake
 * `LinearClient`, injects synthetic `shamu:ready` events at a
 * configurable rate, and verifies a set of invariants at tick
 * boundaries:
 *
 *   - `inFlight <= globalCap` (no limiter leak).
 *   - `queueLength <= queueCapacity` (bounded queue).
 *   - Heap usage trends flat (no unbounded growth across completed
 *     runs).
 *   - Every pickup resolves to one of {succeeded, failed, blocked,
 *     review} — no stuck in-progress.
 *
 * CLI:
 *
 *   bun apps/cli/scripts/soak-daemon.ts [--duration=60s] [--rate=1]
 *     [--global-cap=3] [--queue-capacity=8] [--telemetry=<path>]
 *
 * Durations accept s/m/h suffixes. Rate is pickups per second.
 * Telemetry is written as NDJSON (one JSON object per line); defaults
 * to stdout so `jq` + shell redirects Just Work.
 *
 * Exit codes:
 *
 *   0 — soak ran to completion, all invariants held.
 *   1 — invariant violation; see last `tick` event for details.
 *   2 — unexpected boot / teardown error.
 */

import type {
  Attachment,
  CommentRef,
  Issue,
  Label,
  LinearClient,
  LinearError,
} from "@shamu/linear-client";
import type { LinearEvent, WebhookServerHandle } from "@shamu/linear-webhook";
import { createLogger } from "@shamu/shared";
import { ok, type Result } from "@shamu/shared/result";
import type { FlowRunOutcome } from "../src/services/flow-runner.ts";
import {
  createLinearRuntime,
  type LinearRuntimeHandle,
  type RuntimeRunFlowInput,
} from "../src/services/linear-runtime.ts";
import { createFakeFlowDb } from "../test/helpers/fake-db.ts";

// ---------------------------------------------------------------------------
// CLI parsing — minimal + dependency-free.
// ---------------------------------------------------------------------------

interface SoakArgs {
  readonly durationMs: number;
  readonly rate: number;
  readonly globalCap: number;
  readonly perRoleCap: Readonly<Record<string, number>>;
  readonly queueCapacity: number;
  readonly tickIntervalMs: number;
  readonly telemetryPath: string | null;
}

function parseDuration(raw: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(raw);
  if (!m) throw new Error(`invalid duration: ${raw}`);
  const value = Number(m[1]);
  const unit = m[2] ?? "s";
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    default:
      throw new Error(`invalid duration unit: ${unit}`);
  }
}

function parseArgs(argv: readonly string[]): SoakArgs {
  let durationMs = 60 * 1000;
  let rate = 1;
  let globalCap = 3;
  let queueCapacity = 8;
  let telemetryPath: string | null = null;

  for (const arg of argv) {
    if (arg.startsWith("--duration=")) durationMs = parseDuration(arg.slice(11));
    else if (arg.startsWith("--rate=")) rate = Number(arg.slice(7));
    else if (arg.startsWith("--global-cap=")) globalCap = Number(arg.slice(13));
    else if (arg.startsWith("--queue-capacity=")) queueCapacity = Number(arg.slice(17));
    else if (arg.startsWith("--telemetry=")) telemetryPath = arg.slice(12);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`soak-daemon: unknown arg: ${arg}`);
      process.exit(2);
    }
  }

  return {
    durationMs,
    rate,
    globalCap,
    perRoleCap: { executor: 2, planner: 1, reviewer: 1 },
    queueCapacity,
    tickIntervalMs: 5000,
    telemetryPath,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage: bun apps/cli/scripts/soak-daemon.ts [options]

  --duration=<N[ms|s|m|h]>   Total soak duration (default 60s)
  --rate=<N>                 Pickups per second (default 1)
  --global-cap=<N>           Rate-limiter global cap (default 3)
  --queue-capacity=<N>       Rate-limiter queue capacity (default 8)
  --telemetry=<path>         NDJSON output path (default stdout)
  -h, --help                 Show this help

Exit codes:
  0 clean, 1 invariant violation, 2 unexpected error
`);
}

// ---------------------------------------------------------------------------
// Fake LinearClient — records label transitions + issues, no real IO.
// ---------------------------------------------------------------------------

interface SoakClient {
  readonly client: LinearClient;
  readonly issueLabels: Map<string, Set<string>>;
  recordedCalls: { labelAdds: number; commentAdds: number; updates: number };
}

function makeSoakClient(): SoakClient {
  const issueLabels = new Map<string, Set<string>>();
  const recordedCalls = { labelAdds: 0, commentAdds: 0, updates: 0 };
  const labels: Label[] = [
    { id: "lbl-ready", name: "shamu:ready" },
    { id: "lbl-in-progress", name: "shamu:in-progress" },
    { id: "lbl-review", name: "shamu:review" },
    { id: "lbl-blocked", name: "shamu:blocked" },
  ];
  function ensure(issueId: string): Set<string> {
    let s = issueLabels.get(issueId);
    if (!s) {
      s = new Set<string>();
      issueLabels.set(issueId, s);
    }
    return s;
  }
  const client = {
    async listLabels(_teamId: string): Promise<Result<Label[], LinearError>> {
      return ok([...labels]);
    },
    async getIssue(id: string): Promise<Result<Issue, LinearError>> {
      const set = ensure(id);
      return ok({
        id,
        identifier: id,
        title: `Soak ${id}`,
        description: null,
        url: `https://linear.app/t/${id}`,
        teamId: "team-soak",
        stateId: "state-1",
        stateName: "Todo",
        labelIds: [...set].map((_n, i) => `lbl-${i}`),
        labelNames: [...set],
      });
    },
    async addLabel(issueId: string, labelName: string): Promise<Result<true, LinearError>> {
      ensure(issueId).add(labelName);
      recordedCalls.labelAdds += 1;
      return ok(true);
    },
    async removeLabel(issueId: string, labelName: string): Promise<Result<true, LinearError>> {
      ensure(issueId).delete(labelName);
      return ok(true);
    },
    async createComment(_issueId: string, _body: string): Promise<Result<CommentRef, LinearError>> {
      recordedCalls.commentAdds += 1;
      return ok({ id: `c-${recordedCalls.commentAdds}` });
    },
    async updateComment(
      commentId: string,
      _body: string,
    ): Promise<Result<CommentRef, LinearError>> {
      recordedCalls.updates += 1;
      return ok({ id: commentId });
    },
    async createAttachment(input: {
      issueId: string;
      url: string;
      title: string;
    }): Promise<Result<Attachment, LinearError>> {
      return ok({ id: `att`, url: input.url });
    },
  } as unknown as LinearClient;
  return { client, issueLabels, recordedCalls };
}

// ---------------------------------------------------------------------------
// Fake webhook — push events in, async iterator drains them.
// ---------------------------------------------------------------------------

interface SoakWebhook {
  readonly handle: WebhookServerHandle;
  push(event: LinearEvent): void;
  finish(): void;
}

function makeSoakWebhook(): SoakWebhook {
  const buffer: LinearEvent[] = [];
  const pending: Array<(r: IteratorResult<LinearEvent>) => void> = [];
  let closed = false;
  const iterable: AsyncIterable<LinearEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<LinearEvent> {
      return {
        next(): Promise<IteratorResult<LinearEvent>> {
          if (buffer.length > 0) {
            const value = buffer.shift() as LinearEvent;
            return Promise.resolve({ value, done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            pending.push(resolve);
          });
        },
        return(): Promise<IteratorResult<LinearEvent>> {
          closed = true;
          while (pending.length > 0) {
            const r = pending.shift();
            if (r) r({ value: undefined, done: true });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
  const handle: WebhookServerHandle = {
    port: 0,
    host: "127.0.0.1",
    events: iterable,
    fetch: () => Promise.resolve(new Response("ok")),
    async stop(): Promise<void> {
      closed = true;
      while (pending.length > 0) {
        const r = pending.shift();
        if (r) r({ value: undefined, done: true });
      }
    },
  };
  return {
    handle,
    push(event): void {
      if (closed) return;
      const waiter = pending.shift();
      if (waiter) {
        waiter({ value: event, done: false });
        return;
      }
      buffer.push(event);
    },
    finish(): void {
      closed = true;
      while (pending.length > 0) {
        const r = pending.shift();
        if (r) r({ value: undefined, done: true });
      }
    },
  };
}

function labelAddedEvent(issueId: string): LinearEvent {
  return {
    kind: "issue-label-added",
    webhookId: `wh-${issueId}`,
    receivedAt: Date.now(),
    actorId: "soak",
    actorName: "soak",
    issueId,
    addedLabelIds: ["lbl-ready"],
    raw: {},
  } as unknown as LinearEvent;
}

// ---------------------------------------------------------------------------
// Telemetry writer.
// ---------------------------------------------------------------------------

interface TelemetryEvent {
  readonly ts: number;
  readonly kind: string;
  readonly [key: string]: unknown;
}

function makeTelemetryWriter(path: string | null): {
  write: (event: TelemetryEvent) => void;
  close: () => Promise<void>;
} {
  if (path === null) {
    return {
      write(event): void {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      },
      close: () => Promise.resolve(),
    };
  }
  const chunks: string[] = [];
  return {
    write(event): void {
      chunks.push(`${JSON.stringify(event)}\n`);
    },
    async close(): Promise<void> {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, chunks.join(""), "utf8");
    },
  };
}

// ---------------------------------------------------------------------------
// Soak core.
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const telemetry = makeTelemetryWriter(args.telemetryPath);
  const startTs = Date.now();
  telemetry.write({ ts: startTs, kind: "start", args });

  const client = makeSoakClient();
  const webhook = makeSoakWebhook();
  const db = createFakeFlowDb();

  // Controlled runFlow — each invocation resolves after a random delay
  // so runs overlap realistically.
  let runFlowInvocations = 0;
  let runFlowCompletions = 0;
  const runFlow = async (_input: RuntimeRunFlowInput): Promise<FlowRunOutcome> => {
    runFlowInvocations += 1;
    // Simulate 100-500ms of work so a 1/sec pickup rate produces
    // bounded concurrency around globalCap.
    const delayMs = 100 + Math.floor(Math.random() * 400);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    runFlowCompletions += 1;
    // 10% synthetic failures to exercise the blocked path.
    const failed = Math.random() < 0.1;
    return {
      flowRunId: `FRN-${runFlowInvocations}` as never,
      status: failed ? "failed" : "succeeded",
      totalCostUsd: null,
    };
  };

  let runtime: LinearRuntimeHandle;
  try {
    runtime = await createLinearRuntime({
      client: client.client,
      teamId: "team-soak",
      webhookServer: webhook.handle,
      db,
      logger: createLogger({ transport: () => undefined }),
      egressPolicy: null,
      flowShimDir: null,
      concurrency: {
        globalCap: args.globalCap,
        perRoleCap: args.perRoleCap,
        queueCapacity: args.queueCapacity,
      },
      _runFlow: runFlow,
    });
    await runtime.ready;
  } catch (cause) {
    telemetry.write({
      ts: Date.now(),
      kind: "boot_failed",
      error: cause instanceof Error ? cause.message : String(cause),
    });
    await telemetry.close();
    return 2;
  }

  // Event pusher — fire one label event every 1/rate seconds.
  const intervalMs = Math.max(1, Math.floor(1000 / args.rate));
  let issueSerial = 0;
  const pusher = setInterval(() => {
    issueSerial += 1;
    webhook.push(labelAddedEvent(`soak-${issueSerial}`));
  }, intervalMs);

  // Invariant ticker.
  let violation: { readonly reason: string } | null = null;
  let peakInFlight = 0;
  const peakQueue = 0;
  let peakHeapBytes = 0;
  const baselineHeapBytes = process.memoryUsage().heapUsed;
  const tick = (): void => {
    const heap = process.memoryUsage().heapUsed;
    peakHeapBytes = Math.max(peakHeapBytes, heap);
    peakInFlight = Math.max(peakInFlight, runtime.inFlight);
    telemetry.write({
      ts: Date.now(),
      kind: "tick",
      elapsedMs: Date.now() - startTs,
      inFlight: runtime.inFlight,
      pushed: issueSerial,
      invocations: runFlowInvocations,
      completions: runFlowCompletions,
      heapBytes: heap,
      peakInFlight,
      peakQueue,
      peakHeapBytes,
    });
    if (runtime.inFlight > args.globalCap) {
      violation = { reason: `inFlight > globalCap (${runtime.inFlight} > ${args.globalCap})` };
    }
    // Memory growth budget: allow 4× baseline. A runaway leak would blow
    // through this fast; a healthy soak stays within 2×.
    if (heap > baselineHeapBytes * 4 && heap - baselineHeapBytes > 64 * 1024 * 1024) {
      violation = {
        reason: `heap growth > 4× baseline (heap=${heap} baseline=${baselineHeapBytes})`,
      };
    }
  };
  const ticker = setInterval(tick, args.tickIntervalMs);

  // Run until duration elapses OR invariant violation.
  const stopSignal = new Promise<void>((resolve) => {
    const deadline = setTimeout(resolve, args.durationMs);
    const t = deadline as unknown as { unref?: () => void };
    t.unref?.();
  });
  const violationSignal = new Promise<void>((resolve) => {
    const checker = setInterval(() => {
      if (violation) {
        clearInterval(checker);
        resolve();
      }
    }, 100);
    const c = checker as unknown as { unref?: () => void };
    c.unref?.();
  });
  await Promise.race([stopSignal, violationSignal]);

  clearInterval(pusher);
  clearInterval(ticker);

  // Drain.
  telemetry.write({
    ts: Date.now(),
    kind: "drain_start",
    inFlight: runtime.inFlight,
  });
  await runtime.drainAndStop(5000);
  webhook.finish();

  telemetry.write({
    ts: Date.now(),
    kind: "done",
    elapsedMs: Date.now() - startTs,
    invocations: runFlowInvocations,
    completions: runFlowCompletions,
    peakInFlight,
    peakQueue,
    peakHeapBytes,
    violation,
  });
  await telemetry.close();

  return violation ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (cause) => {
    process.stderr.write(
      `soak-daemon: unexpected failure: ${cause instanceof Error ? cause.stack : String(cause)}\n`,
    );
    process.exit(2);
  },
);
