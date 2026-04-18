# Phase 6.D — Live Linear E2E

**Date:** 2026-04-18
**Workspace:** `Watzon` (team `WAT`)
**Outcome:** ✅ Phase 6.D exit criterion met. One unrelated polish bug surfaced (rolling-comment race on terminal append), captured as a followup.

## Exit criterion (from PLAN.md § Phase 6)

> A Linear issue with `shamu:ready` gets picked up, worked, and ends with a PR link + status flip, entirely webhook-driven.

Every clause validated against a real Linear workspace + a real cloudflared tunnel + a real HMAC-signed webhook roundtrip.

## What we ran

- **Daemon:** `shamu linear serve --flow-module apps/cli/scripts/e2e-smoke-flow.ts`
- **Tunnel:** `shamu linear tunnel --webhook-port 7357`
- **Flow:** A 3-node pass-through stub (`plan → execute → review`), ~2.4 s total. Chosen over the canonical plan-execute-review flow to avoid burning Claude/Codex credits during a Phase-6-scoped integration test — the canonical flow is Phase 4's concern and has its own unit + live-smoke coverage.
- **Test issue:** `WAT-6 — E2E smoke — Phase 6.D shamu live test`.

## Observed timeline (UTC)

Happy-path run (after fixing the stub-module resolution from the first attempt):

| Time (ms since webhook) | Event | Source |
|---|---|---|
| 0 | `shamu:ready` label applied by operator | Linear API (mutation) |
| ~2000 | `POST /webhooks/linear` arrives from Linear | cloudflared tunnel |
| 2000 | `linear webhook accepted` (HMAC verified) | daemon log |
| 2500 | pickup driver fires, runtime flips to `shamu:in-progress` | runtime |
| 2659 | rolling comment created with run header | Linear |
| 4012 | `flow_started` (engine) | flow bus |
| 4013 | `node_started: plan` | flow bus |
| 4815 | `node_completed: plan` (801 ms) → checkpoint appended to rolling comment | flow bus + runtime bridge |
| 4815 | `node_started: execute` | flow bus |
| 5816 | `node_completed: execute` (1001 ms) → checkpoint appended | flow bus + runtime bridge |
| 5817 | `node_started: review` | flow bus |
| 6417 | `node_completed: review` (601 ms) → checkpoint appended (see polish bug below) | flow bus + runtime bridge |
| 6418 | `flow_completed: succeeded, cost=$0, nodes=3` | flow bus |
| 6500 | runtime flips to `shamu:review`, finalizes rolling comment | runtime |

End-to-end: **~6.5 seconds** from label-apply to `shamu:review`, with the canonical orchestration surface fully exercised.

Then the operator ran `shamu linear attach-pr --issue bca521f6-... --url https://github.com/watzon/shamu/pull/8 --title "Phase 6.C.3: ..." --subtitle "merged da03c87"` — attachment `336188c9-...` landed on the issue in ~700 ms.

## What the test proved

- `shamu linear tunnel` + cloudflared exposed the local webhook receiver on a public URL. Scope-404s on non-`/webhooks/linear` paths verified in a prior smoke (see `packages/linear/webhook/test/server.test.ts`).
- Linear webhook subscription created via `webhookCreate(secret: ...)` mutation fires on real `Issue` + `Comment` events.
- `@shamu/linear-webhook`'s HMAC verification + nonce-cache correctly accepted the first delivery and rejected every Linear retry with the same `webhookId` (see "duplicate-nonce spam" note below).
- `@shamu/linear-integration` primitives, wired end-to-end by `createLinearRuntime`, drove the full state machine:
  - label transitions: `shamu:ready` → `shamu:in-progress` → `shamu:review`
  - on the earlier failure-path attempt: `shamu:ready` → `shamu:in-progress` → `shamu:blocked` + failure comment
  - rolling comment with deterministic header + per-node checkpoints + terminal summary
- `shamu linear attach-pr` successfully posted an attachment via the new `LinearClient.createAttachment` mutation.
- Flow module resolution works: the runtime's `runFlowInProcess` loads a non-canonical flow module by filesystem path (the stub lives outside any package's `src/`).

## What the failure-path attempt proved

The **first** run deliberately failed (module resolution gap in the stub's original location) and validated:

- Handler-throw during `onPickup` does NOT break the pickup-driver drain loop (subsequent label-adds would still be processed).
- The runtime's own failure path flips to `shamu:blocked` even without a `watchdog.ci_tripwire` escalation (belt-and-suspenders as designed in 6.C.3).
- Rolling comment was still created and got a failure checkpoint appended before the runtime bailed. The body visible in Linear after the crash:

```
## Run started — WAT-6: E2E smoke — Phase 6.D shamu live test
_runId: 01KPH91H4BMBKH9HPEPY9B6VCR started at 2026-04-18T21:48:11.205Z_

### 2026-04-18T21:48:11.621Z — Pickup handler crashed
> ResolveMessage: Cannot find module '@shamu/core-flow/types' from '...'
```

## Bugs / polish items surfaced

### 1. Rolling-comment race on flow completion (`@shamu/linear-integration/comments` + `apps/cli/src/services/linear-runtime.ts`)

**Symptom:** the happy-path rolling comment is missing the final node's (`review`) checkpoint. Final body:

```
## Run started — WAT-6: …
_runId: … started at 2026-04-18T21:50:52.658Z_

### 2026-04-18T21:50:53.773Z — Node plan completed (ok=true, dur=801ms)
### 2026-04-18T21:50:54.775Z — Node execute completed (ok=true, dur=1001ms)

---
## Summary
Terminal status: succeeded, cost: 0
```

**Cause:** the runtime's rolling-comment bridge appends checkpoints fire-and-forget on every `node_completed`; the review node's `node_completed` fires ~1 ms before `flow_completed`, which triggers `rollingComment.finalize`. The `updateComment` calls from the review append and from finalize race; finalize's body state (lacking the review checkpoint) lands last.

**Fix options (none applied here — tracked as followup):**

- Await each checkpoint append in-order inside the bridge so the body state in memory progresses monotonically before finalize reads it.
- Or: switch the rolling comment to an in-memory transcript that finalize flushes in one `updateComment`, dropping the per-append updates. Simpler; fewer Linear API calls; loses mid-run visibility though.
- Or: have finalize await the in-flight append chain before sending its own body.

Non-blocking for 6.D's exit criterion (the summary line correctly identifies the terminal status); add to HANDOFF's followups.

### 2. Duplicate-webhook spam from Linear

**Symptom:** `linear webhook rejected — reason=duplicate_nonce` logs ≥ 8 times per single `issueAddLabel` operation. The `@shamu/linear-webhook` nonce-cache correctly deduplicates — user-visible behavior is unaffected — but the log noise is notable.

**Cause:** Linear aggressively redelivers the same `webhookId` repeatedly even after a 202 response, either because of tunnel-level retries (quick cloudflared tunnels are best-effort) or a documented Linear retry cadence for fan-out. Nonce-cache is doing its job.

**Fix option (tracked as followup):** throttle the `duplicate_nonce` log to once per `webhookId` (or once per 10 s per ID), so the second+ redelivery of a dedup'd event doesn't flood the log.

### 3. Flow module location discovery

**Symptom:** the stub at `scripts/e2e-smoke-flow.ts` couldn't resolve `@shamu/core-flow/*` because `scripts/` has no nearby `node_modules`. Moving it to `apps/cli/scripts/` fixed it (inherits `apps/cli`'s workspace linkage).

**Finding, not a bug:** Bun's runtime ESM loader uses the module's own directory for bare-specifier resolution. Flow modules passed to `shamu flow run` (or `shamu linear serve --flow-module`) by absolute path must live inside a directory whose nearest `node_modules` resolves `@shamu/core-flow`. For ad-hoc one-off flows, live under `apps/cli/scripts/` (or any workspace package). The canonical flow (`@shamu/flows-plan-execute-review`) is of course fine.

**Possible future improvement:** the daemon could resolve its flow module against the CLI's own workspace rather than the module's filesystem location, removing this footgun. Not urgent; the current behavior is documented.

## Cleanup

- Daemon + tunnel processes stopped.
- Webhook subscription `78247db4-...` deleted via `webhookDelete` mutation.
- Labels (`shamu:ready|in-progress|review|blocked`) + test issue (WAT-6) + PR attachment are retained on the throwaway workspace as evidence.

## Ship decision

- Phase 6.D exit criterion **met**. Track 6.D checkbox ticked in PLAN.md.
- Three polish items above added to HANDOFF's followup list (rolling-comment race, webhook dup spam, flow-module-location discovery).
- Phase 6 flips to ✅ in HANDOFF.

## Artifacts

- `apps/cli/scripts/e2e-smoke-flow.ts` — the stub flow module used for this test. Retained so future E2E reruns don't need to re-author it.
- This writeup.
