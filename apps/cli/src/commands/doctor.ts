/**
 * `shamu doctor` — environment + toolchain health check.
 *
 * Runs checks that can execute right now (Bun/Node/Docker/Git versions, platform,
 * config loadable, keychain tool reachable) and reports Phase-gated checks as
 * `todo` so users can see the full picture. Exit OK if every check passes;
 * INTERNAL otherwise.
 */

import { spawnSync } from "node:child_process";
import { defineCommand } from "citty";
import { loadConfig } from "../config.ts";
import { ExitCode, type ExitCodeValue } from "../exit-codes.ts";
import { ansiEnabled, writeHuman, writeJson } from "../output.ts";
import { auditChainCheck } from "../services/doctor-audit-chain.ts";
import { clockSkewCheck } from "../services/doctor-clock.ts";
import { egressBrokerCheck } from "../services/doctor-egress.ts";
import { tunnelScopeCheck } from "../services/doctor-tunnel-scope.ts";
import { webhookServerCheck } from "../services/doctor-webhook.ts";
import { commonArgs, done, outputMode } from "./_shared.ts";

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** `todo` marks a check that's deliberately stubbed until a future phase. */
  readonly status: "pass" | "fail" | "todo";
}

const MIN_BUN = [1, 3, 0] as const;
const MIN_NODE = [18, 0, 0] as const;
const MIN_GIT = [2, 40, 0] as const;

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Check Shamu's environment, toolchain, and config.",
  },
  args: {
    ...commonArgs,
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const checks: CheckResult[] = [];

    checks.push(checkBun());
    checks.push(checkNode());
    checks.push(checkGit());
    checks.push(checkDocker());
    checks.push(checkPlatform());
    checks.push(await checkConfig(args.config));
    checks.push(checkKeychain());

    // Phase-8.C real checks (audit chain, egress broker, clock, webhook,
    // tunnel scope). Each helper is isolated so a crash in one doesn't take
    // the whole doctor down — the `await` wraps lift into `CheckResult`s
    // even on reject paths.
    checks.push(await wrap("audit_events chain", auditChainCheck()));
    checks.push(await wrap("egress broker", egressBrokerCheck()));
    checks.push(await wrap("clock skew", clockSkewCheck()));
    checks.push(await wrap("webhook server", webhookServerCheck()));
    checks.push(wrapSync("tunnel scope", tunnelScopeCheck()));

    const anyFail = checks.some((c) => c.status === "fail");

    if (mode === "json") {
      for (const c of checks) {
        writeJson(mode, {
          kind: "doctor",
          name: c.name,
          ok: c.ok,
          status: c.status,
          detail: c.detail,
        });
      }
      writeJson(mode, { kind: "doctor-summary", ok: !anyFail, total: checks.length });
    } else {
      writeHuman(mode, "shamu doctor");
      writeHuman(mode, "");
      for (const c of checks) {
        writeHuman(mode, `  ${glyph(c.status)}  ${pad(c.name, 22)}  ${c.detail}`);
      }
      writeHuman(mode, "");
      writeHuman(mode, anyFail ? "result: one or more checks failed." : "result: all checks ok.");
    }

    return done(anyFail ? ExitCode.INTERNAL : ExitCode.OK);
  },
});

function glyph(status: CheckResult["status"]): string {
  const ansi = ansiEnabled();
  if (status === "pass") return ansi ? "\u001b[32mok\u001b[0m " : "ok ";
  if (status === "fail") return ansi ? "\u001b[31mXX\u001b[0m " : "XX ";
  return ansi ? "\u001b[33m--\u001b[0m " : "-- ";
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function checkBun(): CheckResult {
  const version = typeof Bun !== "undefined" ? Bun.version : process.versions.bun;
  if (!version) {
    return {
      name: "bun",
      ok: false,
      status: "fail",
      detail: "Bun runtime not detected. Shamu requires Bun >= 1.3.0.",
    };
  }
  const ok = compareSemver(parseSemver(version), MIN_BUN) >= 0;
  return {
    name: "bun",
    ok,
    status: ok ? "pass" : "fail",
    detail: `${version}${ok ? "" : " (need >= 1.3.0)"}`,
  };
}

function checkNode(): CheckResult {
  const version = process.versions.node;
  const ok = compareSemver(parseSemver(version), MIN_NODE) >= 0;
  return {
    name: "node",
    ok,
    status: ok ? "pass" : "fail",
    detail: `${version}${ok ? "" : " (need >= 18.0.0 for agent-ci)"}`,
  };
}

function checkGit(): CheckResult {
  const out = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (out.status !== 0 || !out.stdout) {
    return {
      name: "git",
      ok: false,
      status: "fail",
      detail: "git not reachable on PATH.",
    };
  }
  const match = /(\d+\.\d+\.\d+)/.exec(out.stdout);
  if (!match?.[1]) {
    return { name: "git", ok: false, status: "fail", detail: `cannot parse: ${out.stdout.trim()}` };
  }
  const version = match[1];
  const ok = compareSemver(parseSemver(version), MIN_GIT) >= 0;
  return {
    name: "git",
    ok,
    status: ok ? "pass" : "fail",
    detail: `${version}${ok ? "" : " (need >= 2.40.0)"}`,
  };
}

function checkDocker(): CheckResult {
  const out = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  if (out.status !== 0 || !out.stdout) {
    // Docker is optional for Phase 1, so this is `fail` only if explicitly
    // requested. For now we emit a warn-shaped pass (ok=false, status=todo)
    // so users see it but don't block on it.
    return {
      name: "docker",
      ok: true,
      status: "todo",
      detail: "not reachable (optional until Phase 7 egress broker / Phase 8 sandbox).",
    };
  }
  return {
    name: "docker",
    ok: true,
    status: "pass",
    detail: out.stdout.trim(),
  };
}

function checkPlatform(): CheckResult {
  const platform = process.platform;
  const ok = platform === "darwin" || platform === "linux";
  return {
    name: "platform",
    ok,
    status: ok ? "pass" : "fail",
    detail: `${platform}${ok ? "" : " (shamu supports darwin + linux)"}`,
  };
}

async function checkConfig(explicit: string | undefined): Promise<CheckResult> {
  const params: Parameters<typeof loadConfig>[0] = {};
  if (explicit !== undefined) params.explicitPath = explicit;
  const result = await loadConfig(params);
  if (result.ok) {
    const where = result.source ?? "defaults (no shamu.config.ts found)";
    return { name: "config", ok: true, status: "pass", detail: `loaded: ${where}` };
  }
  return {
    name: "config",
    ok: false,
    status: "fail",
    detail: `${result.error.kind}: ${result.error.message}`,
  };
}

function checkKeychain(): CheckResult {
  if (process.platform === "darwin") {
    const out = spawnSync("security", ["list-keychains"], { encoding: "utf8" });
    if (out.status !== 0) {
      return {
        name: "keychain",
        ok: false,
        status: "fail",
        detail: "`security list-keychains` failed.",
      };
    }
    const count = out.stdout.split("\n").filter((l) => l.trim().length > 0).length;
    return {
      name: "keychain",
      ok: true,
      status: "pass",
      detail: `macOS Keychain reachable (${count} keychain(s)).`,
    };
  }
  if (process.platform === "linux") {
    const which = spawnSync("which", ["secret-tool"], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim().length > 0) {
      return {
        name: "keychain",
        ok: true,
        status: "pass",
        detail: `secret-tool found at ${which.stdout.trim()}`,
      };
    }
    // Fallback: check for a Secret Service socket indirectly by presence of
    // `gnome-keyring` / `kwallet` binaries. Not authoritative, but useful.
    const hints = ["gnome-keyring-daemon", "kwalletd5", "kwalletd6"].filter((bin) => {
      const r = spawnSync("which", [bin], { encoding: "utf8" });
      return r.status === 0 && r.stdout.trim().length > 0;
    });
    if (hints.length > 0) {
      return {
        name: "keychain",
        ok: true,
        status: "pass",
        detail: `libsecret backend hinted by ${hints.join(", ")} (install secret-tool for cleanest UX).`,
      };
    }
    return {
      name: "keychain",
      ok: false,
      status: "fail",
      detail:
        "secret-tool not found and no Secret Service hint; install libsecret-tools (Debian/Ubuntu) or equivalent.",
    };
  }
  return {
    name: "keychain",
    ok: false,
    status: "fail",
    detail: `unsupported platform: ${process.platform}`,
  };
}

/**
 * Attach a `name` to an async helper's `{status, ok, detail}` result. Catches
 * throws so a helper crash becomes a `fail` check rather than a doctor-level
 * unhandled rejection.
 */
async function wrap(
  name: string,
  promise: Promise<{ status: "pass" | "fail" | "todo"; ok: boolean; detail: string }>,
): Promise<CheckResult> {
  try {
    const r = await promise;
    return { name, ok: r.ok, status: r.status, detail: r.detail };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { name, ok: false, status: "fail", detail: `check crashed: ${message}` };
  }
}

/** Sync variant of `wrap` for helpers that don't return a Promise. */
function wrapSync(
  name: string,
  result: { status: "pass" | "fail" | "todo"; ok: boolean; detail: string },
): CheckResult {
  return { name, ok: result.ok, status: result.status, detail: result.detail };
}

function parseSemver(input: string): readonly [number, number, number] {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(input);
  if (!match?.[1] || !match[2] || !match[3]) return [0, 0, 0] as const;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function compareSemver(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
