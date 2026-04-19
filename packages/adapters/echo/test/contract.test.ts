/**
 * Run the shared adapter contract suite against the echo adapter.
 *
 * Scenarios that require capabilities echo declares `off` (fork, custom
 * tools, MCP) self-skip with a loud warning — that's expected behavior
 * per PLAN.md § Adapter acceptance criteria.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHandle } from "@shamu/adapters-base";
import type { AdapterUnderTest } from "@shamu/adapters-base/contract";
import { runAdapterContractSuite } from "@shamu/adapters-base/contract";
import { afterAll, beforeAll } from "vitest";
import { ECHO_CAPABILITIES, EchoAdapter } from "../src/index.ts";

let rootDir: string;

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), "shamu-echo-contract-"));
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

const adapter = new EchoAdapter();
const aut: AdapterUnderTest = {
  adapter,
  vendor: adapter.vendor,
  capabilities: ECHO_CAPABILITIES,
  factory: async (ctx) => adapter.spawn(ctx.spawnOpts),
  teardown: async (handle: AgentHandle) => {
    try {
      await handle.shutdown("contract-teardown");
    } catch {
      // Idempotent in the echo handle; swallow.
    }
  },
  worktreeFor: async (scenarioName) => {
    const dir = join(rootDir, scenarioName.replace(/[^a-z0-9_-]/gi, "_"));
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  // Phase 7.G migration: the echo `chooseScript` wires both G4 and G5
  // probes to synthetic `permission_request: deny` + `error` scripts so
  // the contract suite can run fail-loud across the stub adapter too.
  // Echo has no real permission handler — the `scriptProbe` promise is
  // about driver-side visibility of a rejection, not real enforcement.
  scriptProbe: (probe) => probe === "path-scope" || probe === "shell-gate",
};

runAdapterContractSuite(aut, { timeoutMs: 5_000 });
