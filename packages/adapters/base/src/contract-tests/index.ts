/**
 * `@shamu/adapters-base/contract-tests` — canonical entry point for the
 * shared contract-test harness.
 *
 * Phase 7.A introduces this subpath so downstream adapters (opencode, the
 * ACP-stdio tracks, the stream-JSON-shell variations) import from a stable
 * name that won't drift as the harness grows. The existing
 * `@shamu/adapters-base/contract` subpath is preserved so echo / claude /
 * codex keep working with no test-file churn; both subpaths re-export the
 * same symbols.
 *
 * Keep this file thin — scenario implementations and types live under
 * `../contract/`. This is a pure re-export boundary.
 */

export {
  assertPlantedSecretScrubbed,
  FAIL_TURN,
  FOLLOWUP_TURN,
  HELLO_TURN,
  LONG_TURN,
  PATCH_TURN,
  PATH_SCOPE_ESCAPE_TURN,
  PLANTED_SECRET,
  REDACTED_PLACEHOLDER_PREFIX,
  SECRET_TURN,
  SHELL_SUBSTITUTION_TURN,
  TOOL_CALL_TURN,
} from "../contract/fixtures.ts";
export type { Scenario } from "../contract/index.ts";
export {
  CONTRACT_SCENARIOS,
  runAdapterContractSuite,
} from "../contract/index.ts";
export type {
  AdapterFactory,
  AdapterUnderTest,
  ContractLogger,
  ContractSuiteOptions,
  ScenarioContext,
  ScriptProbeId,
} from "../contract/types.ts";
