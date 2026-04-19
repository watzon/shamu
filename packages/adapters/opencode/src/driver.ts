/**
 * OpenCode driver — isolates the vendor SDK behind a narrow interface the
 * handle consumes. Two drivers ship:
 *
 * 1. `realOpencodeDriver` — wraps `createOpencode()` (owned local server) or
 *    `createOpencodeClient({ baseUrl })` (attach-to-existing-server). The
 *    adapter owns the subprocess lifecycle when it spawned the server; on
 *    `shutdown()` it calls `server.close()` so no zombie Bun/Node processes
 *    linger (PLAN Phase 0.A constraint: all vendor CLIs are Node-based and
 *    Bun fire-and-forget cleanup is not sufficient).
 *
 * 2. Tests pass a scripted double: see `test/driver.test.ts` and
 *    `test/contract.test.ts`. The double supplies the same `OpencodeSdkClient`
 *    shape but never spawns a real server.
 *
 * ### Transport notes (PLAN § "Transport-class summary")
 *
 * OpenCode is the SSE-HTTP reference adapter. Events arrive via the SDK's
 * `event.subscribe()` call, which returns a `ServerSentEventsResult` with
 * an async-generator `.stream` of `Event` values. We project those one-by-
 * one through `projection.ts`.
 *
 * `session.prompt({ path: { id }, body: { parts: [...] } })` is a unary
 * HTTP POST that resolves with the final `AssistantMessage` + all `Part`s
 * for the turn; it does NOT itself return a stream. The live SSE stream is
 * the source of per-delta events.
 *
 * ### Known gotchas
 *
 * - `session.prompt` streaming-return shape is not fully documented in the
 *   npm page (anti-bot returned 403 during the spike; see
 *   `docs/phase-7/adapter-transports.md`). The SDK's generated types
 *   (verified against `@opencode-ai/sdk@1.4.14`): `prompt` returns a
 *   `RequestResult<{info, parts}>` — so a unary response is correct and the
 *   event stream is separate. If a future 1.4.x exposes a streaming shape
 *   on `prompt`, revisit.
 * - Task-tool deadlock (OpenCode#6573) — a hung tool can stall the SSE
 *   stream. The driver exposes a watchdog hook: when
 *   `promptTimeoutMs` elapses the handle aborts via `session.abort`.
 */

import type { OpencodeClient } from "@opencode-ai/sdk";
import { SpawnError } from "@shamu/adapters-base";

/**
 * Minimum surface the handle uses. Declaring it structurally lets unit
 * tests stub it out without importing the real `@opencode-ai/sdk`.
 */
export interface OpencodeSdkClient {
  readonly session: {
    create(args: { body?: { title?: string; parentID?: string } }): Promise<{
      data?: { id: string; title?: string; directory?: string; [k: string]: unknown };
    }>;
    get(args: { path: { id: string } }): Promise<{
      data?: { id: string; [k: string]: unknown };
    }>;
    prompt(args: {
      path: { id: string };
      body: {
        // Matches SDK `SessionPromptData.body.parts`: a mutable-typed array of
        // text/file/agent/subtask input parts. We use a narrower input shape
        // (text-only) but have to declare it mutable to assign into the SDK.
        parts: Array<{ type: "text"; text: string }>;
        noReply?: boolean;
        system?: string;
      };
    }): Promise<{ data?: { info?: unknown; parts?: unknown } }>;
    abort(args: { path: { id: string } }): Promise<{ data?: boolean }>;
  };
  readonly event: {
    subscribe(): Promise<{
      stream: AsyncGenerator<unknown, void, unknown>;
    }>;
  };
  readonly auth: {
    set(args: {
      path: { id: string };
      body: { type: "api"; key: string };
    }): Promise<{ data?: boolean }>;
  };
}

/**
 * Handle lifecycle around an owned or borrowed client. The driver is what
 * gets torn down when the handle shuts down; callers never touch the raw
 * SDK objects directly.
 */
export interface OpencodeDriver {
  /** The SDK client used for REST calls. */
  readonly client: OpencodeSdkClient;
  /**
   * Close the owned server (if the driver started one) or release the
   * client reference (if we attached to an existing server).
   *
   * MUST be idempotent — `AgentHandle.shutdown()` may be called twice in
   * error paths and the second call is expected to no-op.
   */
  close(): Promise<void>;
}

/** Where to find or how to spawn the OpenCode server. */
export interface OpencodeDriverOptions {
  /**
   * Attach to an already-running OpenCode server instead of spawning one.
   * When set, `close()` only releases the client reference.
   *
   * This is the path a long-lived daemon takes: the server is started by
   * the user's OpenCode session and shamu just talks to it.
   */
  readonly attachBaseUrl?: string;
  /**
   * Owned-server host. Passed to `createOpencode({ hostname })`. Default
   * inherits SDK's default (`127.0.0.1`).
   */
  readonly hostname?: string;
  /**
   * Owned-server port. `0` means "OS-assigned". Default is `0` — we
   * override the SDK's own default of 4096 (the OpenCode TUI port) so
   * parallel spawns don't collide.
   */
  readonly port?: number;
  /** Spawn timeout passed to `createOpencode`. */
  readonly spawnTimeoutMs?: number;
  /**
   * When set, use this factory instead of the real SDK. Test seam only —
   * production never provides it. The factory returns a fully-wired
   * `OpencodeDriver`; creation errors surface as `SpawnError`.
   */
  readonly factory?: (opts: OpencodeDriverOptions) => Promise<OpencodeDriver>;
}

/**
 * The real-SDK driver factory. Split into a standalone export so the adapter
 * can pass it into `driverFactory` without dragging the runtime import into
 * test files.
 */
export async function createRealOpencodeDriver(
  opts: OpencodeDriverOptions,
): Promise<OpencodeDriver> {
  // Lazy-import so tests that supply their own factory never pay the SDK
  // import cost. Keeps the test graph small.
  const sdk = await import("@opencode-ai/sdk");
  if (opts.attachBaseUrl) {
    const client = sdk.createOpencodeClient({ baseUrl: opts.attachBaseUrl });
    const clientShim: OpencodeSdkClient = adaptClient(client);
    return {
      client: clientShim,
      async close() {
        // Attached-mode: nothing to reap. The user owns the server.
      },
    };
  }
  try {
    // Default the port to `0` (OS-assigned). The SDK's own default is the
    // fixed OpenCode TUI port (4096), which collides if a second spawn
    // (another `shamu run`, a sibling test in the same vitest worker, or
    // the user's desktop TUI) already holds it. Orchestrators that need
    // deterministic binding can still pass an explicit `port`.
    const port = opts.port ?? 0;
    const { client, server } = await sdk.createOpencode({
      ...(opts.hostname !== undefined ? { hostname: opts.hostname } : {}),
      port,
      ...(opts.spawnTimeoutMs !== undefined ? { timeout: opts.spawnTimeoutMs } : {}),
    });
    let closed = false;
    return {
      client: adaptClient(client),
      async close() {
        if (closed) return;
        closed = true;
        try {
          server.close();
        } catch {
          // Swallow — close() is best-effort; the AgentHandle contract is
          // "queue closes, subprocess reaped on effort."
        }
      },
    };
  } catch (cause) {
    throw new SpawnError(
      `createOpencode() failed: ${(cause as Error)?.message ?? String(cause)}`,
      cause,
    );
  }
}

/**
 * Wrap the SDK's typed `OpencodeClient` in the narrower `OpencodeSdkClient`
 * shape. The SDK's methods return typed response envelopes
 * (`{ data, error, response, ... }`); we keep the same shape so consumers
 * can use `.data` uniformly whether running against the real SDK or a stub.
 *
 * Marked `unknown`-heavy internally because the generated types are extensive
 * and we only hit a narrow slice; further narrowing lives in the handle's
 * projection path.
 */
function adaptClient(client: OpencodeClient): OpencodeSdkClient {
  return {
    session: {
      async create(args) {
        return (await client.session.create(args)) as Awaited<
          ReturnType<OpencodeSdkClient["session"]["create"]>
        >;
      },
      async get(args) {
        return (await client.session.get(args)) as Awaited<
          ReturnType<OpencodeSdkClient["session"]["get"]>
        >;
      },
      async prompt(args) {
        return (await client.session.prompt(args)) as Awaited<
          ReturnType<OpencodeSdkClient["session"]["prompt"]>
        >;
      },
      async abort(args) {
        return (await client.session.abort(args)) as Awaited<
          ReturnType<OpencodeSdkClient["session"]["abort"]>
        >;
      },
    },
    event: {
      async subscribe() {
        const res = await client.event.subscribe();
        return { stream: res.stream as AsyncGenerator<unknown, void, unknown> };
      },
    },
    auth: {
      async set(args) {
        return (await client.auth.set(args)) as Awaited<
          ReturnType<OpencodeSdkClient["auth"]["set"]>
        >;
      },
    },
  };
}
