/**
 * Runs the shared adapter contract suite against an OpenCodeAdapter that
 * drives a scripted SDK double. Live-vendor tests are gated separately
 * (see test/live/*.live.test.ts and SHAMU_OPENCODE_LIVE=1). This suite
 * MUST be fast + hermetic — no subprocesses.
 *
 * The scripted driver inspects the last `session.prompt` text and replays
 * a tailored SSE event sequence so the handle's projector sees realistic
 * input for each scenario.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event as OpencodeEvent } from "@opencode-ai/sdk";
import type { AgentHandle } from "@shamu/adapters-base";
import type { AdapterUnderTest } from "@shamu/adapters-base/contract-tests";
import { runAdapterContractSuite } from "@shamu/adapters-base/contract-tests";
import { afterAll, beforeAll } from "vitest";
import {
  createOpencodeAdapter,
  OPENCODE_CAPABILITIES,
  type OpencodeDriver,
  type OpencodeSdkClient,
} from "../src/index.ts";

let rootDir: string;

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), "shamu-opencode-contract-"));
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

const PLANTED_SECRET = "sk-ant-FAKE-FIXTURE-aAbBcCdDeEfFgGhHiI123456";

/**
 * Build the SSE event sequence for a given prompt text. Covers every
 * contract scenario: spawn-basic, resume-warm, multi-turn, interrupt,
 * set-model, tool-call-visibility, patch-metadata, usage-and-cost,
 * error-surfaces, secret-redaction, path-scope-dispatch, shell-ast-gate.
 */
function scriptForPrompt(sessionID: string, prompt: string): OpencodeEvent[] {
  const events: OpencodeEvent[] = [];

  // Error-forcing prompt. `FAIL_TURN`'s fixture text mentions
  // `definitely-does-not-exist`; we emit a session.error + idle so
  // `turn_end` lands.
  if (/definitely-does-not-exist/i.test(prompt)) {
    events.push({
      type: "session.error",
      properties: {
        sessionID,
        error: {
          name: "UnknownError",
          data: { message: "tool not found" },
        },
      },
    } as OpencodeEvent);
    events.push({
      type: "session.idle",
      properties: { sessionID },
    } as OpencodeEvent);
    return events;
  }

  // Long-running prompt ("Count slowly..."). We emit only a starter text
  // delta so the interrupt scenario can fire before terminal events.
  if (/Count slowly/i.test(prompt)) {
    events.push({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-count-1",
          sessionID,
          messageID: "msg-count",
          type: "text",
          text: "1",
        },
      },
    } as OpencodeEvent);
    // Deliberately do NOT emit session.idle here; the contract's interrupt
    // scenario triggers handle.interrupt(), which forces a turn_end.
    return events;
  }

  // Path-scope probe: script a pending Write tool-call at an absolute out-
  // of-cwd path. The handle's permission handler rejects BEFORE the tool
  // runs and emits an error with code `path_scope_violation`.
  if (/CONTRACT_PROBE_PATH_SCOPE_ESCAPE/.test(prompt)) {
    events.push({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-pathscope",
          sessionID,
          messageID: "msg-ps",
          type: "tool",
          callID: "call-pathscope",
          tool: "write",
          state: {
            status: "pending",
            input: { file_path: "/etc/shamu-contract-probe.txt", content: "probe" },
            raw: "",
          },
        },
      },
    } as OpencodeEvent);
    // The handle forces a turn_end after aborting; no idle needed.
    return events;
  }

  // Shell-gate probe: script a pending Bash call with `$()`.
  if (/CONTRACT_PROBE_SHELL_SUBSTITUTION/.test(prompt)) {
    events.push({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-shell",
          sessionID,
          messageID: "msg-sh",
          type: "tool",
          callID: "call-shell",
          tool: "bash",
          state: {
            status: "pending",
            input: { command: "echo $(whoami)" },
            raw: "",
          },
        },
      },
    } as OpencodeEvent);
    return events;
  }

  // Default: assistant text + optional tool-call + terminal idle.
  const wantsSecretEcho = prompt.includes(PLANTED_SECRET);
  const assistantText = wantsSecretEcho
    ? `Echoing back: ${PLANTED_SECRET}`
    : prompt.length > 0
      ? prompt.slice(0, 24)
      : "hello";

  events.push({
    type: "message.part.updated",
    properties: {
      part: {
        id: "part-text",
        sessionID,
        messageID: "msg-1",
        type: "text",
        text: assistantText,
      },
    },
  } as OpencodeEvent);

  // Tool-call-visibility: prompts mentioning `Read .+README.md` exercise
  // the tool_call/tool_result round-trip.
  if (/Read .+README\.md/i.test(prompt)) {
    events.push({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-tool",
          sessionID,
          messageID: "msg-1",
          type: "tool",
          callID: "call-read",
          tool: "read",
          state: {
            status: "completed",
            input: { file_path: "README.md" },
            output: "README contents",
            title: "read",
            metadata: {},
            time: { start: 0, end: 1 },
          },
        },
      },
    } as OpencodeEvent);
  }

  // Patch-metadata: "Create a file ..." prompts emit a patch part + a
  // pseudo-tool-call that writes the file (in-cwd, so the permission
  // handler allows it).
  if (/Create a file named note\.txt/i.test(prompt)) {
    events.push({
      type: "message.part.updated",
      properties: {
        part: {
          id: "part-patch",
          sessionID,
          messageID: "msg-1",
          type: "patch",
          hash: "abc123",
          files: ["note.txt"],
        },
      },
    } as OpencodeEvent);
  }

  // Assistant message summary with finish + step-finish for usage/cost.
  events.push({
    type: "message.updated",
    properties: {
      info: {
        id: "msg-1",
        sessionID,
        role: "assistant",
        time: { created: 0, completed: 1 },
        parentID: "msg-0",
        modelID: "gpt-5.4",
        providerID: "openai",
        mode: "default",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: {
          input: 10,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        finish: "end_turn",
      },
    },
  } as OpencodeEvent);

  events.push({
    type: "session.idle",
    properties: { sessionID },
  } as OpencodeEvent);

  return events;
}

function makeScriptedDriver(): OpencodeDriver {
  const sessionIDs = new Set<string>();
  let counter = 0;
  // Persistent per-driver stream buffer. Pushes that happen BEFORE the
  // handle subscribes (during adapter.spawn → session.create) are buffered
  // here; when the handle's subscription lands, they're delivered in order.
  // Lifecycle: one subscription per driver (matches the handle's usage).
  const buffer: OpencodeEvent[] = [];
  const waiters: Array<(ev: IteratorResult<OpencodeEvent>) => void> = [];
  let closed = false;

  const push = (ev: OpencodeEvent): void => {
    if (closed) return;
    const w = waiters.shift();
    if (w) w({ value: ev, done: false });
    else buffer.push(ev);
  };
  const closeStream = (): void => {
    closed = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (w) w({ value: undefined, done: true });
    }
  };

  const client: OpencodeSdkClient = {
    session: {
      async create() {
        counter += 1;
        const id = `sess-contract-${counter}`;
        sessionIDs.add(id);
        // Fire a session.created so the projector emits session_start.
        // Use a deferred push that lands BEFORE prompt's events so the
        // `session_start → ... → turn_end` order is preserved.
        push({
          type: "session.created",
          properties: {
            info: {
              id,
              projectID: "p",
              directory: "/tmp",
              title: "contract",
              version: "v",
              time: { created: 0, updated: 0 },
            },
          },
        } as OpencodeEvent);
        return { data: { id } };
      },
      async get(args) {
        if (!sessionIDs.has(args.path.id)) {
          // Simulate resume bind via a session.updated event.
          sessionIDs.add(args.path.id);
        }
        push({
          type: "session.updated",
          properties: {
            info: {
              id: args.path.id,
              projectID: "p",
              directory: "/tmp",
              title: "resumed",
              version: "v",
              time: { created: 0, updated: 0 },
            },
          },
        } as OpencodeEvent);
        return { data: { id: args.path.id } };
      },
      async prompt(args) {
        const text = args.body.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
        const events = scriptForPrompt(args.path.id, text);
        // Push all events synchronously so the SSE stream drains them in
        // order before the handle's watchdog or other background timers
        // can race.
        for (const ev of events) {
          push(ev);
        }
        return { data: {} };
      },
      async abort(args) {
        // Simulate server response: emit session.idle so the handle's
        // turn_end lands via the normal path (in addition to the forced
        // turn_end the handle already emits on its own).
        push({
          type: "session.idle",
          properties: { sessionID: args.path.id },
        } as OpencodeEvent);
        return { data: true };
      },
    },
    event: {
      async subscribe() {
        async function* gen(): AsyncGenerator<OpencodeEvent, void, unknown> {
          while (!closed) {
            const buf = buffer.shift();
            if (buf) {
              yield buf;
              continue;
            }
            const next = await new Promise<IteratorResult<OpencodeEvent>>((resolve) => {
              waiters.push(resolve);
            });
            if (next.done) return;
            yield next.value;
          }
        }
        return { stream: gen() };
      },
    },
    auth: {
      async set() {
        return { data: true };
      },
    },
  };

  return {
    client,
    async close() {
      closeStream();
    },
  };
}

const adapter = createOpencodeAdapter({
  driverFactory: async () => makeScriptedDriver(),
});

const aut: AdapterUnderTest = {
  adapter,
  vendor: adapter.vendor,
  capabilities: OPENCODE_CAPABILITIES,
  factory: async (ctx) => adapter.spawn(ctx.spawnOpts),
  teardown: async (handle: AgentHandle) => {
    try {
      await handle.shutdown("contract-teardown");
    } catch {
      // idempotent
    }
  },
  worktreeFor: async (scenarioName) => {
    const dir = join(rootDir, scenarioName.replace(/[^a-z0-9_-]/gi, "_"));
    mkdirSync(dir, { recursive: true });
    return dir;
  },
};

runAdapterContractSuite(aut, { timeoutMs: 5_000 });
