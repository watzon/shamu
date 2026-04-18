# Phase 7 — Adapter transport classification

Purpose: classify the five remaining Phase 7 adapters (OpenCode, Pi, Cursor, Gemini, Amp) by transport shape so we can decide how many **reference adapters** we need (distinct transport classes) and how many tracks are variations on an existing reference. Kimi is deferred to a Phase 7.X backlog bucket (user decision, 2026-04-18). Date: 2026-04-18.

## Per-adapter table

| Vendor | Entry-point + version | Transport class | Streaming shape | Session / resume | Auth surface | Notable gotchas |
|--------|----------------------|-----------------|-----------------|------------------|--------------|-----------------|
| **OpenCode** | `@opencode-ai/sdk@1.4.14` (npm; `createOpencode()` starts a local HTTP server, or `createOpencodeClient()` attaches to an existing one at `127.0.0.1:4096`) | **SSE-HTTP** (typed REST + SSE event stream) | Per-event via `event.subscribe()` (`/event` session-scoped, `/global/event` server-scoped); `for await (const e of events.stream)` | Native — `session.create` / `session.get` / `session.prompt`; `sessionId` threads across requests; `body.noReply` separates context-only writes | `client.auth.set({ path: { id: "<provider>" }, body: { type: "api", key: "…" } })` — BYO-provider-keys stored server-side | Server is a spawned Bun/Node subprocess the SDK owns; a hung tool in the `Task` tool has open upstream issues (#6573) for SSE deadlock; our adapter should `shutdown()` the child on `AgentHandle.shutdown` |
| **Pi** | `@mariozechner/pi-coding-agent@0.67.68` (bin: `pi`); start with `pi --mode rpc [--provider …] [--model …] [--no-session] [--session-dir …]` | **JSON-RPC-style JSONL over stdio** (not JSON-RPC 2.0 envelope; strict JSONL with LF-only delimiter) | Per-event — handshake emits `{"type":"ready"}`, commands get `{"type":"response", id, success, …}`, async events (`tool_execution_start/update/end`, content deltas, usage) stream to stdout with no `id` | Native — sessions persist to disk by default; `--no-session` opts out; `switch_session` / `new_session` / `fork` commands; `get_session_stats` surfaces tokens + cost | CLI config file or provider-specific env (Pi is BYO-key per provider via `pi login` or config) | **LF-only JSONL delimiter** (unicode line separators break the stream); tool calls embedded in `AssistantMessage` content **and** surfaced via `tool_execution_*` events — pick one projection path; Node-drain backpressure applies (Pi is a Node process) |
| **Cursor** | `cursor-agent` CLI (internal binary at `~/.local/bin/agent`) — launch ACP server with `agent acp`; versioned via Cursor desktop build, no npm package for the CLI itself | **ACP-stdio** (JSON-RPC 2.0, newline-delimited, over stdin/stdout) — shipped GA 2026-03-04 | Per-event via ACP `session/update` notifications while `session/prompt` is in flight; `session/request_permission` is server-initiated prompt | Native — ACP `session/new` / `session/load`; supports forking-style reloads | `agent login` (interactive), `--api-key` / `CURSOR_API_KEY`, `--auth-token` / `CURSOR_AUTH_TOKEN`; ACP advertises `cursor_login` auth method | **No npm distribution** — binary ships with Cursor app (or installer script); our adapter must resolve `vendorCliPath` against `~/.local/bin/agent` by default and declare `customTools: false`, `mcp` per ACP client capability. Model selection limited to subagent-level `model: "fast"` — main-session model is account default |
| **Gemini** | `@google/gemini-cli@0.38.2` (bin: `gemini`); launch ACP server with `gemini --acp` (no longer `--experimental-acp`) | **ACP-stdio** (identical to Cursor: JSON-RPC 2.0 over stdio) | Per-event via ACP `session/update` notifications | Native — ACP `session/new` + `session/load`; `unstable_setSessionModel` flagged unstable for mid-session model changes | `GEMINI_API_KEY` / `GOOGLE_AI_API_KEY` env, or interactive `/login`; ACP advertises `authenticate` method | Gemini-CLI is 111 MB unpacked and is a Node process (drain applies); stdout corruption issue filed upstream (gemini-cli#22647) where non-ACP writes can bleed into the JSON-RPC stream — adapter must validate every line and surface malformed lines as `error` rather than crash. **No standalone SDK** — the CLI is the only surface, same shape as `vendorCliPath` in Claude/Codex |
| **Amp** | `@sourcegraph/amp@0.0.1776542811-g13eef6` (bin: `amp`); non-interactive with `amp -x "<prompt>" --stream-json [--stream-json-input]`; resume with `amp threads continue <thread-id> -x … --stream-json` | **Stream-JSON-shell** (JSONL over subprocess stdio; Claude/Codex family) | Per-event — `{type:"system", session_id, …}` init, `{type:"user"}` / `{type:"assistant"}` messages, terminal `{type:"result", duration, success}` | Native via named threads — `amp threads continue <id>` resumes; each CLI invocation is one conversation turn (or more if `--stream-json-input` stays open) | `AMP_API_KEY` env (non-interactive); `amp login` for subscription + auth token persisted in keychain (npm dep is `@napi-rs/keyring`) | Commercial license on the CLI binary — package the distribution note, not the CLI itself. Each invocation is short-lived unless `--stream-json-input` keeps stdin open → adapter must choose between "per-turn subprocess" (simple, loses mid-run context window cache) or "long-lived stdin" (matches Claude/Codex shape). Pick long-lived. |

### Quick shape notes vs existing reference adapters

- `packages/adapters/claude` — spawns `@anthropic-ai/claude-agent-sdk`'s `query()` / v2 session (SDK-library transport), projects JSONL internally. Our `AgentEvent` union already maps cleanly (`reasoning`, `rate_limit`, `usage`, `cost`, `tool_*`, `patch_applied`).
- `packages/adapters/codex` — spawns Codex SDK (SDK-library); `costReporting: "subscription"`, `mcp: "stdio"`.
- Both share the same `CorrelationState` + `EventQueue` + hook-projection shape; new adapters can reuse the EventQueue + redactor pattern regardless of transport class.

## Transport-class summary

- **ACP-stdio (JSON-RPC 2.0, stdin/stdout, `session/update` notifications):** Cursor, Gemini. Identical wire format — one reference adapter covers both; the second track is a `vendorCliPath` change + auth-method wiring + capability declarations.
- **SSE-HTTP (local HTTP server + typed REST + `/event` SSE):** OpenCode. Only member of its class. Cleanest structural mirror of our `AgentEvent` union — typed events land almost 1:1.
- **Stream-JSON-shell (JSONL over subprocess stdio, non-ACP):** Amp, plus the existing Claude + Codex SDK adapters. Amp is the first stream-JSON adapter that is **not** an SDK — it's a shell-out with `-x --stream-json`. Good candidate to live alongside Claude/Codex as a "shell-family" variant once we've proven ACP + SSE.
- **JSONL-over-stdio (custom, not JSON-RPC 2.0):** Pi. Close to Amp/Claude in wire shape but with its own command + event dictionary. Variation on Amp with a different projector.
- **REST-poll:** None, now that Cursor has ACP. The PLAN's 7.C description ("REST + webhook; async job handles; no streaming; poll fallback") is obsolete.

## Proposed reference-adapter count + order

**Two reference adapters, three variation adapters.** Validates the parent's hypothesis.

1. **OpenCode (first; SSE-HTTP reference).** Typed events, explicit session REST, per-provider auth via `client.auth.set`. Cleanest structural mirror of `AgentEvent`; forces us to write an SSE projector that every future HTTP-transport adapter (Cursor cloud / Jules / Replit Agent if they ever ship) can reuse.
2. **Cursor-via-ACP (second; ACP-stdio reference).** Build the shared ACP projector here, including `session/update` → `AgentEvent` mapping, `session/request_permission` → `permission_request` handshake, and `cursor_login` auth. Once this is done, Gemini is a configuration + capability-declaration PR, not an implementation PR.
3. **Gemini (variation of ACP; drafted in parallel with Cursor's second review iteration).** Reuses the ACP projector; differs only in binary path, auth methods, and capability flags (`unstable_setSessionModel` → `setModel` capability declaration).
4. **Amp (variation of Claude/Codex shell-family).** Long-lived `amp -x --stream-json --stream-json-input` subprocess, map `{type:"system"}` → `session_start`, `{type:"assistant"}` → `assistant_message`, `{type:"result"}` → `turn_end`. `costReporting: "subscription"`, `mcp: "none"`, `customTools: false`.
5. **Pi (variation of Amp's shell-family with a custom projector).** Same subprocess shell as Amp, different JSONL dictionary (`type:"response"` vs `type:"result"`, `tool_execution_*` events). Highest-complexity projector of the batch.

Kimi moves to **Phase 7.X backlog**: OpenAI-compat chat + shamu-owned tool loop is a fundamentally different shape (no vendor session, no vendor tool calls, no rate-limit signal) and the ROI is low until the other five are proven.

## Proposed PLAN.md edits (not applied — parent applies)

```diff
@@ Phase 7 — Adapter fan-out + web dashboard @@
-Biggest parallel fan of any phase. Six adapter tracks plus one web-dashboard track, all independent. Each lands individually once its contract suite is green.
+Biggest parallel fan of any phase. Five adapter tracks plus one web-dashboard track, all independent. Kimi moved to Phase 7.X (deferred backlog) — OpenAI-compat + BYO tool loop is a different shape and lower ROI than proving the five standardized transports first. Each track lands individually once its contract suite is green.

-**Tracks 7.A–7.F — Adapters (all Parallel)**
-- [ ] 7.A — `packages/adapters/opencode` on `@opencode-ai/sdk` (SSE event mapping; BYO provider keys via `client.auth.set`)
-- [ ] 7.B — `packages/adapters/pi` on `@mariozechner/pi-coding-agent` (`runRpcMode` + event subscribe)
-- [ ] 7.C — `packages/adapters/cursor` (REST + webhook; async job handles; no streaming; poll fallback)
-- [ ] 7.D — `packages/adapters/gemini` on `@google/gemini-cli-sdk`
-- [ ] 7.E — `packages/adapters/amp` shelling out to `amp -x --stream-json`
-- [ ] 7.F — `packages/adapters/kimi`: OpenAI-compat chat + our own tool loop (fallback template)
+**Tracks 7.A–7.E — Adapters (all Parallel)**
+Reference-adapter order (2 transport classes + 3 variations):
+- [ ] 7.A — `packages/adapters/opencode` on `@opencode-ai/sdk@1.4.x` — **SSE-HTTP reference**. SDK starts a local HTTP server (`createOpencode()`) or attaches to an existing one (`createOpencodeClient()`); events via `event.subscribe()` SSE stream. Sessions are first-class (`session.create/get/prompt`, `sessionId` round-trips). Auth via `client.auth.set({ path: { id: "<provider>" }, body: { type: "api", key } })` — BYO-provider-keys. Adapter owns subprocess lifecycle of the OpenCode server (shutdown on `AgentHandle.shutdown`).
+- [ ] 7.B — `packages/adapters/cursor` — **ACP-stdio reference**. Launch `agent acp` (binary at `~/.local/bin/agent` from the Cursor app; no npm distribution). Transport: JSON-RPC 2.0 newline-delimited over stdio; `session/new` + `session/load` + `session/prompt` + `session/update` notifications + `session/request_permission`. Auth via `agent login`, `--api-key` / `CURSOR_API_KEY`, or `--auth-token` / `CURSOR_AUTH_TOKEN`; ACP auth method advertised as `cursor_login`. `customTools: false` (Cursor's tools are hosted); `setModel` limited to subagent `model: "fast"`.
+- [ ] 7.C — `packages/adapters/gemini` on `@google/gemini-cli@0.38.x` (bin: `gemini --acp`) — **ACP-stdio variation**. Reuses 7.B's ACP projector; differs in binary path, auth (`GEMINI_API_KEY` / `GOOGLE_AI_API_KEY` env or interactive login), and capability flags (`unstable_setSessionModel` → declare `setModel` as `"per-session"`). No standalone SDK — the CLI is the transport.
+- [ ] 7.D — `packages/adapters/amp` shelling out to `@sourcegraph/amp` (bin: `amp`) with `amp -x --stream-json --stream-json-input` — **stream-JSON-shell variation** of the Claude/Codex family. Long-lived subprocess keeps stdin open; `{type:"system", session_id}` → `session_start`, `{type:"assistant"}` → `assistant_message`, `{type:"result"}` → `turn_end`. Resume via `amp threads continue <id>`. Auth via `AMP_API_KEY` env (non-interactive) or `amp login` (keychain-backed, subscription). `costReporting: "subscription"`; `mcp: "none"`; `customTools: false`.
+- [ ] 7.E — `packages/adapters/pi` on `@mariozechner/pi-coding-agent@0.67.x` (bin: `pi --mode rpc`) — **JSONL-over-stdio variation** (not JSON-RPC 2.0; Pi's own command dictionary). Handshake `{type:"ready"}`; commands/responses correlated by optional `id`; async events streamed with no `id` (`tool_execution_start/update/end`, content deltas, usage). Sessions persist to disk; `--no-session` opts out. **LF-only delimiter** (strict JSONL — reject Unicode-separator-aware line readers). Tool calls surface both in `AssistantMessage.content` and via `tool_execution_*` events — project from the event stream, not the content blocks.
+- [ ] 7.F — (retired; see Phase 7.X below)
```

```diff
@@ end of Phase 7 (insert new backlog subsection before Phase 8) @@
+### Phase 7.X — Deferred adapters
+
+Scoped out of Phase 7 at kickoff (2026-04-18) because the ROI is low until the standardized transports are proven. Picked up post-Phase-7 exit or alongside Phase 8.
+
+- [ ] Kimi adapter — OpenAI-compatible chat endpoint + shamu-owned tool loop. Different shape from every other vendor: no native session, no native tool calls (shamu owns the ReAct loop), no rate-limit signal mapped to our `rate_limit` event. Useful as a "fallback template" for any future OpenAI-compat-only provider (DeepSeek, Mistral Large, local llama.cpp servers, etc.) — but not load-bearing for the first Phase 7 release.
```

```diff
@@ Parallelization summary (table row for Phase 7) @@
-| 7 | **7** | Adapter fan-out + web dashboard → capability matrix |
+| 7 | **6** | Adapter fan-out (5 vendors) + web dashboard → capability matrix |
```

```diff
@@ Design principles → "Why these choices (from research)" @@
-- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.2.x) and Codex SDK (`@openai/codex-sdk`) are both **subprocess + JSONL event stream** under the hood. OpenCode, Pi, Amp, Gemini CLI, Aider, Q all fit the same shape. **Three adapter templates cover the entire market:** (a) subprocess + JSONL/SSE, (b) cloud REST + webhook (Cursor, Jules), (c) OpenAI-compatible chat + our own tool loop (Kimi + fallback).
+- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.2.x) and Codex SDK (`@openai/codex-sdk`) are both **subprocess + JSONL event stream** under the hood. After Phase 7 research (2026-04-18) the transport matrix shook out as **four live classes plus one fallback**: (a) SDK-library subprocess (Claude, Codex); (b) SSE-HTTP with typed REST session API (OpenCode); (c) ACP-stdio / JSON-RPC 2.0 (Cursor as of 2026-03-04, Gemini CLI `--acp`); (d) stream-JSON / custom-JSONL shell (Amp, Pi); (e) OpenAI-compat + shamu-owned tool loop (Kimi — deferred to 7.X). The "cloud REST + webhook" row originally scoped for Cursor is now **obsolete** — Cursor shipped ACP in March 2026.
```

## Open questions for the user

- **Cursor CLI distribution.** `agent acp` ships inside the Cursor desktop app / installer, not npm. How do we want users to get it? Options: (a) require Cursor Desktop installed and resolve `vendorCliPath` → `~/.local/bin/agent` by default; (b) document a curl-installer bootstrap in `shamu doctor`; (c) sidecar-bootstrap the way Phase 0 planned for Claude's 200MB binary. Recommend (a) for Phase 7; revisit (c) for the Phase 8 `bun build --compile` release.
- **ACP projector package location.** Do we want `packages/adapters/base/acp/` (shared ACP projector + client harness consumed by `adapters/cursor` and `adapters/gemini`), or `packages/protocol/acp/` (peer to a future `packages/protocol/a2a/` from Phase 8)? Recommend `packages/protocol/acp/` — ACP is a protocol, not an adapter, and a future A2A bridge may speak it directly.
- **Amp: long-lived `--stream-json-input` subprocess vs per-turn.** Long-lived matches Claude/Codex shape and preserves the vendor's context window cache, but amp's thread-state model works across invocations via `amp threads continue <id>`. Either works; long-lived is simpler for `interrupt()` semantics. Confirm before spawning the Amp track.
- **Pi's `customTools` + `mcp` declaration.** Pi exposes a hostable tool set and has an MCP client. Do we declare `mcp: "stdio"` and let Pi drive MCP servers itself, or `mcp: "in-process"` and have shamu mediate? Needs a Pi-docs spike as part of 7.E, not 7 kickoff.
- **Gemini CLI: known stdout-corruption issue.** google-gemini/gemini-cli#22647 notes non-ACP writes can bleed into the JSON-RPC stream. Acceptable risk for Phase 7? Or gate 7.C on an upstream fix? Recommend: ship, validate every line, surface malformed lines as `error` events, add a `gitHubIssueLink` in the adapter README so users know to pin a known-good `@google/gemini-cli` version.

## Research gaps

- **`cursor-agent` `--help` could not be captured.** `npx --yes cursor-agent` resolves to an unrelated `cursor-agent@1.0.3` (a task-sequencer by `zalab-inc`, last published ~1 year ago) — not the Cursor-official binary. The Cursor binary is not on npm; documentation fetched from `cursor.com/docs/cli/acp` is the source of truth.
- **`@google/gemini-cli-sdk`.** Does not exist on npm (returned `E404`). Gemini's ACP surface is the `gemini` CLI itself; there's no separate SDK to wrap. PLAN.md's current wording ("on `@google/gemini-cli-sdk`") is incorrect.
- **OpenCode SDK internals.** Full source fetch of the npm page returned 403 (anti-bot). Behavior captured from the `opencode.ai/docs/sdk/` page and the DeepWiki provider. The exact `session.prompt` streaming shape (does it return an iterable, or do events only flow via `event.subscribe()`?) should be re-verified when the adapter prompt is drafted.
- **Amp's tool-call event names.** `amp-examples-and-guides/guides/cli/README.md` likely has the exact `{type:"tool_use"}` / `{type:"tool_result"}` shape but wasn't fetched to keep the research tight. Re-verify during 7.D prompt drafting.
- **ACP auth round-trip for Cursor.** The `cursor_login` method is advertised but its exact request/response shape (what does the agent expect the client to return?) isn't in the public docs fetched. `@zed-industries/claude-agent-acp`'s source is the likely reference implementation to crib from.

## Evidence log

### npm view output (2026-04-18)

- `@opencode-ai/sdk` → `1.4.14`, published 58 minutes before fetch, deps: `cross-spawn@7.0.6`. 6077 versions (very active).
- `@mariozechner/pi-coding-agent` → `0.67.68`, published 23 hours before fetch; bin: `pi`. 254 versions.
- `@sourcegraph/amp` → `0.0.1776542811-g13eef6` (date-stamped build ID; package versioned continuously), commercial license, bin: `amp`. 2984 versions.
- `@google/gemini-cli` → `0.38.2`, Apache-2.0, bin: `gemini`, 111.6 MB unpacked, 572 versions. `@google/gemini-cli-sdk` does **not** exist (E404).
- `cursor-agent` (npm) → `1.0.3` by `zalab-inc`, a task-sequencer, **not** the Cursor official binary. `@cursor/agent` and `@cursor/cli` both E404. The Cursor CLI ships via Cursor Desktop.

### URLs consulted

- `https://cursor.com/docs/cli/acp` — Cursor's official ACP mode docs. `agent acp`, JSON-RPC 2.0 newline-delimited, `cursor_login` auth method, `--api-key` / `--auth-token` flags.
- `https://blog.jetbrains.com/ai/2026/03/cursor-joined-the-acp-registry…` — GA date for Cursor ACP (2026-03-04) + JetBrains + Zed integration.
- `https://agentclientprotocol.com/get-started/agents` — current ACP agent roster (40+ agents). Spec version: `protocolVersion: 1`.
- `https://agentclientprotocol.com/protocol/overview` — ACP overview: JSON-RPC 2.0, `session/new`, `session/update` notifications, tool-call + plan + mode-change update kinds.
- `https://zed.dev/docs/ai/external-agents` — Gemini / Claude / Codex ACP adapters. Env-var auth. No streaming details.
- `https://geminicli.com/docs/cli/acp-mode/` — `gemini --acp` (promoted from `--experimental-acp`), `authenticate` + `newSession` + `loadSession` methods, `unstable_setSessionModel`.
- `https://opencode.ai/docs/sdk/` — `createOpencode()` / `createOpencodeClient()`, `session.*` REST, `event.subscribe()` SSE, `client.auth.set`.
- `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md` — `pi --mode rpc` entry, strict LF-only JSONL, `{type:"ready"}` handshake, `tool_execution_*` events, session commands.
- `https://ampcode.com/news/streaming-json` — `-x --stream-json --stream-json-input` flags, message dictionary (`system` / `user` / `assistant` / `result`), `amp threads continue` resume.
- `https://github.com/google-gemini/gemini-cli/issues/22647` — stdout-corruption caveat in Gemini ACP mode.
- `https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md` — Gemini ACP spec confirmation + security note on file-scope limitation.

### Relevant repo files (shape comparison)

- `packages/adapters/claude/src/capabilities.json` — `{ resume: true, fork: false, interrupt: "cooperative", mcp: "in-process", customTools: true, costReporting: "native", streaming: "events" }`.
- `packages/adapters/codex/src/capabilities.json` — differs on `mcp: "stdio"`, `customTools: false`, `costReporting: "subscription"`.
- `packages/adapters/echo/src/capabilities.json` — minimum viable shape.
- `packages/adapters/claude/src/handle.ts` — `ClaudeHandle` / `EventQueue` / `ClaudeDriver` pattern the SSE-HTTP and ACP-stdio reference adapters should mirror (single-consumer queue, redactor, `CorrelationState`, shutdown-reaps-subprocess).
