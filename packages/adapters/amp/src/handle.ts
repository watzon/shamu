/**
 * `AmpHandle` — the live `AgentHandle` for an Amp run.
 *
 * Responsibilities:
 *
 * 1. Drain the driver's `readLines()` stream, projecting each JSONL line
 *    through `projectAmpLine` into `AgentEvent`s. Malformed lines surface
 *    as non-fatal `error` events (amp-gemini-style defense).
 * 2. Apply `decideAmpPermission` to `tool_call` events BEFORE surfacing to
 *    the consumer (G4/G5). Amp dispatches server-side so this is advisory
 *    for downstream consumers — a denial still emits `error` and attempts
 *    to end the current turn by closing stdin. Open question (logged as
 *    followup): whether amp has an in-stream cancel message we should
 *    prefer over closing stdin.
 * 3. Run the redactor on every emitted event (G1).
 * 4. On `send()`, write `{"type":"user","message":{"role":"user","content":
 *    [{"type":"text","text":"..."}]}}` as a single JSONL line to amp's
 *    stdin. Long-lived — stdin stays open between turns.
 * 5. 10-min `promptTimeoutMs` watchdog per turn (configurable via
 *    `vendorOpts.promptTimeoutMs`). On expiry: close stdin, force `turn_end`.
 * 6. `interrupt(reason)` — Amp's JSONL spec as of 2026-04-18 does not
 *    document an in-stream cancel message. We adopt the conservative
 *    approach: close stdin and force the current turn to end synthetically.
 *    The subprocess then exits after its current tool drains; the handle's
 *    consumer sees `turn_end` either from a real `{type:"result"}` or from
 *    our synthetic fallback.
 * 7. `shutdown(reason)` — close driver first (which closes stdin, waits
 *    for amp to drain, then SIGTERM/SIGKILL if necessary), then close queue.
 *
 * Concurrency: one in-flight turn per handle. `send()` while a turn is
 * active throws — the supervisor is responsible for serializing.
 *
 * ### stdin JSON shape for user turns (research gap)
 *
 * The exact schema amp expects for `--stream-json-input` isn't fully
 * documented at `ampcode.com/news/streaming-json` (as of 2026-04-18). We
 * send an Anthropic-message-shaped object since amp's output lines already
 * use that shape for assistant/user/tool_use blocks:
 *
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 *
 * If the live-test feedback loop reveals amp wants a simpler shape
 * (`{"text":"..."}`), the `formatUserTurn` helper is the single edit site.
 *
 * ### Shared harness
 *
 * Event queue, redactor, watchdog, shutdown sequence, envelope threading,
 * and setModel/setPermissionMode defaults live in `AdapterHandleBase`
 * (`@shamu/adapters-base/harness`). Shared with Cursor/Gemini/Pi.
 */

import {
  AdapterHandleBase,
  type AdapterHandleBaseOptions,
  type Capabilities,
  type MonotonicClock,
  type SpawnOpts,
  type UserTurn,
} from "@shamu/adapters-base";
import type { EventId, SessionId, ToolCallId, TurnId } from "@shamu/shared/ids";
import { Redactor } from "@shamu/shared/redactor";
import type { AmpDriver } from "./driver.ts";
import { decideAmpPermission, type PermissionHandlerOptions } from "./permission-handler.ts";
import {
  createProjectionState,
  type ProjectionContext,
  type ProjectionHooks,
  type ProjectionState,
  projectAmpLine,
} from "./projection.ts";

const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

export interface AmpHandleOptions {
  readonly driver: AmpDriver;
  readonly opts: SpawnOpts;
  readonly vendor: string;
  readonly capabilities: Capabilities;
  readonly vendorSessionId: SessionId | null;
  readonly sessionSource: "spawn" | "resume" | "fork";
  readonly clock?: MonotonicClock | undefined;
  readonly newEventId?: (() => EventId) | undefined;
  readonly newTurnId?: (() => TurnId) | undefined;
  readonly newToolCallId?: (() => ToolCallId) | undefined;
  readonly redactor?: Redactor | undefined;
  readonly promptTimeoutMs?: number | undefined;
  /** Override the permission handler (tests). */
  readonly permissionOptionsOverride?: PermissionHandlerOptions | undefined;
}

/**
 * Format a user turn into the JSONL line amp expects on stdin. Exported for
 * tests so alternative shapes can be validated without rebuilding a handle.
 */
export function formatUserTurn(text: string): string {
  const payload = {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  };
  return JSON.stringify(payload);
}

export class AmpHandle extends AdapterHandleBase<ProjectionState> {
  private readonly driver: AmpDriver;
  private readonly permissionOpts: PermissionHandlerOptions;
  private readonly projHooks: ProjectionHooks;
  private stdoutDone: Promise<void>;
  private stderrDone: Promise<void>;

  constructor(options: AmpHandleOptions) {
    const projState = createProjectionState();
    // When resuming, seed the projector's `boundSessionId` so an echo of the
    // session id from amp's first `{type:"system"}` message doesn't rebind
    // and emit a divergent sessionId.
    if (options.vendorSessionId) {
      projState.boundSessionId = options.vendorSessionId;
    }

    const baseOptions: AdapterHandleBaseOptions<ProjectionState> = {
      runId: options.opts.runId,
      initialSessionId: options.vendorSessionId,
      vendor: options.vendor,
      logLabel: "AmpHandle",
      capabilities: options.capabilities,
      projState,
      sessionSource: options.sessionSource,
      redactor: options.redactor ?? new Redactor(),
      initialModel: options.opts.model ?? "amp-default",
      promptTimeoutMs: options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      clock: options.clock,
      newEventId: options.newEventId,
      newTurnId: options.newTurnId,
    };
    super(baseOptions);
    this.driver = options.driver;

    this.projHooks = {
      modelProvider: () => this.currentModel,
      ...(options.newToolCallId ? { newToolCallId: options.newToolCallId } : {}),
      onSessionBound: (sid) => {
        this.bindSessionId(sid);
      },
    };

    this.permissionOpts = options.permissionOptionsOverride ?? {
      worktreeRoot: options.opts.cwd,
    };

    // Kick off stdout + stderr drainers. Fire-and-forget; unhandled rejections
    // land as `error` events if the handle's still open.
    this.stdoutDone = this.consumeStdout().catch((err) => {
      if (this.closed) return;
      this.emitSafely({
        ...this.safeEnvelope(),
        kind: "error",
        fatal: true,
        errorCode: "amp_stdout_failure",
        message: this.redactor.redact((err as Error)?.message ?? String(err)),
        retriable: false,
      });
    });
    this.stderrDone = this.consumeStderr().catch(() => {
      // Stderr is diagnostic; swallow on error.
    });
  }

  async send(message: UserTurn): Promise<void> {
    if (this.closed) throw new Error("AmpHandle: send() after shutdown()");
    if (this.turnActive) {
      throw new Error("AmpHandle: send() while a turn is already active");
    }
    this.beginTurn();

    const redactedText = this.redactor.redact(message.text);
    const line = formatUserTurn(redactedText);
    try {
      await this.driver.writeLine(line);
    } catch (cause) {
      if (!this.closed) {
        this.emitSafely({
          ...this.safeEnvelope(),
          kind: "error",
          fatal: true,
          errorCode: "amp_stdin_failed",
          message: this.redactor.redact((cause as Error)?.message ?? String(cause)),
          retriable: false,
        });
        this.forceTurnEnd("stdin_error");
      }
      return;
    }
  }

  async interrupt(reason?: string): Promise<void> {
    // No documented in-stream cancel on amp's JSONL surface as of 2026-04-18.
    // Closing stdin asks amp to finish the current turn and exit. The driver's
    // close() chain (called from shutdown) escalates to SIGTERM if needed.
    await this.doInterrupt(reason, async () => {
      await this.driver.closeStdin();
    });
  }

  async shutdown(reason: string): Promise<void> {
    await this.runSharedShutdown(reason, {
      closeDriver: () => this.driver.close(),
      // Reap driver first, then wait for the stdout/stderr drainers so any
      // trailing lines land in the queue before it closes.
      drainStream: async () => {
        try {
          await this.stdoutDone;
        } catch {
          // ignore
        }
        try {
          await this.stderrDone;
        } catch {
          // ignore
        }
      },
    });
  }

  // ---- internals --------------------------------------------------------

  protected override onWatchdogFire(): void {
    // Close stdin to ask amp to finish + force turn_end so the consumer
    // advances. The next `send()` will fail with `amp_stdin_failed`
    // because stdin is closed — that's the correct behavior: the handle
    // is dead after a watchdog timeout.
    void this.driver.closeStdin().catch(() => {});
    this.forceTurnEnd("prompt_watchdog");
  }

  private async consumeStdout(): Promise<void> {
    for await (const line of this.driver.readLines()) {
      if (this.closed) break;
      this.handleLine(line);
    }
  }

  private async consumeStderr(): Promise<void> {
    for await (const _chunk of this.driver.readStderr()) {
      if (this.closed) break;
      // Amp's stderr carries diagnostic output (license notice, update
      // checks, etc.). Not surfaced as events today; a future followup may
      // route it into `stdout`/`stderr` AgentEvents gated by a verbose flag.
    }
  }

  private handleLine(line: string): void {
    const ctx: ProjectionContext = {
      corr: this.corr,
      state: this.projState,
      sessionSource: this.sessionSource,
      hooks: this.projHooks,
    };
    const projected = projectAmpLine(line, ctx);
    for (const raw of projected) {
      // G4/G5 gate on tool_call events BEFORE surfacing to the consumer.
      // Amp has already dispatched server-side by the time we see the
      // tool_use block; this gate is advisory (prevents downstream flow
      // consumers from acting on a tool that violates scope). Document
      // this nuance in the contract-suite notes.
      if (raw.kind === "tool_call") {
        const decision = decideAmpPermission(
          { tool: raw.tool, ...(isRecord(raw.args) ? { input: raw.args } : {}) },
          this.permissionOpts,
        );
        if (decision && decision.kind === "denied") {
          // Emit the tool_call so the consumer sees the vendor's intent,
          // then emit the error, then try to cancel the turn.
          this.emit(raw);
          try {
            this.emit({
              ...this.corr.envelope(),
              kind: "error",
              fatal: true,
              errorCode: decision.error.code,
              message: this.redactor.redact(decision.error.message),
              retriable: false,
            });
          } catch {
            // envelope wedged
          }
          // Close stdin so amp drains + exits; synthetic turn_end ensures
          // the consumer's for-await advances even if amp's `{type:"result"}`
          // doesn't land.
          void this.driver.closeStdin().catch(() => {});
          this.forceTurnEnd("path_scope_violation");
          return;
        }
      }
      this.emit(raw);
    }
    // Turn-end trigger: our projector emits `turn_end` on `{type:"result"}`.
    // When projected events include a turn_end, mark turnActive false +
    // disarm watchdog.
    for (const raw of projected) {
      if (raw.kind === "turn_end") {
        this.turnActive = false;
        this.watchdog.clear();
        break;
      }
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
