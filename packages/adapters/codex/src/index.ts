/**
 * `@shamu/adapter-codex` — production `AgentAdapter` wrapping
 * `@openai/codex-sdk@0.121.0`.
 *
 * Entry point + adapter class. Every piece of vendor-specific behavior
 * (JSONL projection, path/shell gate, auth resolution) lives in a sibling
 * module so unit tests can exercise them in isolation.
 *
 * Flow:
 *   new CodexAdapter()
 *     → .spawn(opts) / .resume(sid, opts)
 *       → resolveCodexAuth(opts)         — pick CLI vs API-key path
 *       → new Codex({ codexPathOverride | apiKey })
 *       → codex.startThread(...) | codex.resumeThread(sid, ...)
 *       → new CodexHandle({ thread, opts, capabilities, ... })
 *   handle.send({text})
 *     → thread.runStreamed(text, { signal })
 *       → stream ThreadEvents →
 *         per-event: permission-gate → projectCodexEvent → redact → validate → enqueue
 *
 * runId is orchestrator-owned via `SpawnOpts.runId` — the handle's
 * `runId` always equals `opts.runId` (G8 from threat model).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Codex, type CodexOptions, type ThreadOptions } from "@openai/codex-sdk";
import {
  type AgentAdapter,
  type AgentHandle,
  type Capabilities,
  freezeCapabilities,
  type MonotonicClock,
  type SpawnOpts,
} from "@shamu/adapters-base";
import type { EventId, SessionId, ToolCallId, TurnId } from "@shamu/shared/ids";
import type { Redactor } from "@shamu/shared/redactor";
import { resolveCodexAuth } from "./auth.ts";
import { CodexHandle, type ThreadLike } from "./handle.ts";
import type { ProjectionLogger } from "./jsonl-projection.ts";

export type { ResolvedCodexAuth } from "./auth.ts";
export { CodexAuthMissingError, resolveCodexAuth } from "./auth.ts";
export type { CodexHandle, ThreadLike } from "./handle.ts";
export type { CodexProjectionState, ProjectionLogger } from "./jsonl-projection.ts";
export {
  createProjectionState,
  projectCodexEvent,
  toolNameForItem,
} from "./jsonl-projection.ts";
export type {
  PermissionDecision,
  PermissionHandlerOptions,
} from "./permission-handler.ts";
export {
  checkCommandExecution,
  checkFileChange,
  decidePermission,
} from "./permission-handler.ts";
export { codexVendorCliDescriptor } from "./vendor-cli-descriptor.ts";

/** Default vendor label. Tests may override via `CodexAdapterOptions.vendor`. */
const DEFAULT_VENDOR = "codex";

/** Load the frozen capability manifest from disk (G8 — immutable at runtime). */
function loadCodexCapabilities(): Readonly<Capabilities> {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "capabilities.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return freezeCapabilities(raw);
}

/**
 * Frozen capability manifest for the Codex adapter. Loaded once at module
 * load; every handle shares this reference.
 */
export const CODEX_CAPABILITIES: Readonly<Capabilities> = loadCodexCapabilities();

/**
 * Options accepted by `new CodexAdapter()`. Every field is optional; the
 * defaults produce a production-shaped adapter.
 */
export interface CodexAdapterOptions {
  /**
   * Override how we construct the SDK Codex instance. Primarily for tests
   * that want to inject a scripted `Thread` stub — production callers
   * should leave this unset.
   */
  readonly codexFactory?: (sdkOpts: CodexOptions) => CodexLike;
  /** Pinned monotonic clock (tests). */
  readonly clock?: MonotonicClock;
  /** Pinned event id factory (tests). */
  readonly newEventId?: () => EventId;
  /** Pinned turn id factory (tests). */
  readonly newTurnId?: () => TurnId;
  /** Pinned tool-call id factory (tests; used by the snapshot suite). */
  readonly newToolCallId?: () => ToolCallId;
  /**
   * A pre-configured `Redactor`. One is created per handle by default;
   * callers that want to pre-register run-local secrets (Linear API
   * tokens, user-supplied bearer tokens) pass one in.
   */
  readonly redactor?: Redactor;
  /** Vendor label override. */
  readonly vendor?: string;
  /** Optional structured logger surfaced to the projector. */
  readonly logger?: ProjectionLogger;
}

/**
 * Minimum surface of the `@openai/codex-sdk` `Codex` class we call into.
 * Mirrors `ThreadLike` in `handle.ts` — declaring it here lets tests
 * substitute a hand-written double without importing the real SDK.
 */
export interface CodexLike {
  startThread(options?: ThreadOptions): ThreadLike;
  resumeThread(id: string, options?: ThreadOptions): ThreadLike;
}

/**
 * The Codex `AgentAdapter`. One instance per vendor is fine; `spawn()` /
 * `resume()` each construct a fresh SDK Codex + Thread under the hood.
 *
 * Stateful only insofar as it caches the frozen capabilities manifest and
 * the injected clock / factory references for downstream handles.
 */
export class CodexAdapter implements AgentAdapter {
  public readonly vendor: string;
  public readonly capabilities: Readonly<Capabilities> = CODEX_CAPABILITIES;

  private readonly codexFactory: (sdkOpts: CodexOptions) => CodexLike;
  private readonly clock: MonotonicClock | undefined;
  private readonly eventIdFactory: (() => EventId) | undefined;
  private readonly turnIdFactory: (() => TurnId) | undefined;
  private readonly toolCallIdFactory: (() => ToolCallId) | undefined;
  private readonly redactor: Redactor | undefined;
  private readonly logger: ProjectionLogger | undefined;

  constructor(options: CodexAdapterOptions = {}) {
    this.vendor = options.vendor ?? DEFAULT_VENDOR;
    this.codexFactory = options.codexFactory ?? defaultCodexFactory;
    this.clock = options.clock;
    this.eventIdFactory = options.newEventId;
    this.turnIdFactory = options.newTurnId;
    this.toolCallIdFactory = options.newToolCallId;
    this.redactor = options.redactor;
    this.logger = options.logger;
  }

  async spawn(opts: SpawnOpts): Promise<AgentHandle> {
    const sdk = this.buildSdk(opts);
    const thread = sdk.startThread(this.threadOptions(opts));
    return new CodexHandle({
      thread,
      opts,
      vendor: this.vendor,
      capabilities: this.capabilities,
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
      ...(this.eventIdFactory !== undefined ? { eventIdFactory: this.eventIdFactory } : {}),
      ...(this.turnIdFactory !== undefined ? { turnIdFactory: this.turnIdFactory } : {}),
      ...(this.toolCallIdFactory !== undefined
        ? { toolCallIdFactory: this.toolCallIdFactory }
        : {}),
      ...(this.redactor !== undefined ? { redactor: this.redactor } : {}),
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
    });
  }

  async resume(sessionId: SessionId, opts: SpawnOpts): Promise<AgentHandle> {
    const sdk = this.buildSdk(opts);
    const thread = sdk.resumeThread(sessionId, this.threadOptions(opts));
    return new CodexHandle({
      thread,
      opts,
      vendor: this.vendor,
      capabilities: this.capabilities,
      resumedSessionId: sessionId,
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
      ...(this.eventIdFactory !== undefined ? { eventIdFactory: this.eventIdFactory } : {}),
      ...(this.turnIdFactory !== undefined ? { turnIdFactory: this.turnIdFactory } : {}),
      ...(this.toolCallIdFactory !== undefined
        ? { toolCallIdFactory: this.toolCallIdFactory }
        : {}),
      ...(this.redactor !== undefined ? { redactor: this.redactor } : {}),
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
    });
  }

  /** Build the SDK `Codex` instance with resolved auth + config. */
  private buildSdk(opts: SpawnOpts): CodexLike {
    const auth = resolveCodexAuth({
      ...(opts.vendorCliPath !== undefined ? { vendorCliPath: opts.vendorCliPath } : {}),
    });
    const sdkOpts: CodexOptions = {
      ...(auth.codexPathOverride !== undefined
        ? { codexPathOverride: auth.codexPathOverride }
        : {}),
      ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
      // Only set `env` if the caller supplied one — the SDK's default is
      // "inherit process.env", which is what we want when no broker is
      // injecting proxy vars. When we DO pass env, the SDK stops inheriting
      // `process.env`, so we materialize the process env first and then
      // merge the caller's overrides on top.
      ...(opts.env !== undefined ? { env: mergeProcessEnvWith(opts.env) } : {}),
    };
    return this.codexFactory(sdkOpts);
  }

  /** Map SpawnOpts → Codex-SDK ThreadOptions. */
  private threadOptions(opts: SpawnOpts): ThreadOptions {
    // Codex SDK's ThreadOptions has model, sandboxMode, workingDirectory,
    // approvalPolicy. We map:
    //   opts.model → ThreadOptions.model
    //   opts.cwd → workingDirectory  (and Codex CLI's --cd)
    //   opts.permissionMode=="acceptEdits" → approvalPolicy="never" +
    //     sandboxMode="workspace-write"; "default" → approvalPolicy="on-request"
    const threadOpts: ThreadOptions = {
      workingDirectory: opts.cwd,
    };
    if (opts.model !== undefined) threadOpts.model = opts.model;
    if (opts.permissionMode === "acceptEdits") {
      threadOpts.approvalPolicy = "never";
      threadOpts.sandboxMode = "workspace-write";
    } else {
      threadOpts.approvalPolicy = "on-request";
    }
    return threadOpts;
  }
}

/** Default factory: use the real `@openai/codex-sdk` Codex class. */
function defaultCodexFactory(sdkOpts: CodexOptions): CodexLike {
  const sdk = new Codex(sdkOpts);
  return {
    startThread: (options) => sdk.startThread(options),
    resumeThread: (id, options) => sdk.resumeThread(id, options),
  };
}

/**
 * Materialize `process.env` (filtered to defined string values) and merge
 * the caller's overrides on top. Empty-string overrides delete the key —
 * standard env-merge semantics. Used for the Codex SDK whose `env` option,
 * when provided, stops inheriting `process.env` entirely.
 */
function mergeProcessEnvWith(overrides: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v !== "string") continue;
    if (v.length === 0) {
      delete out[k];
      continue;
    }
    out[k] = v;
  }
  return out;
}
