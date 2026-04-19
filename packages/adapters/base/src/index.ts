/**
 * @shamu/adapters-base — public surface.
 *
 * The adapter contract, the shared primitives every vendor adapter composes
 * against (subprocess spawn, path scope, shell gate, tool-result summary,
 * correlation, replay), and the contract-test suite.
 *
 * Submodules are addressable as `@shamu/adapters-base/<name>` for tree
 * shaking and explicit imports (see `package.json` exports).
 */

export * from "./adapter.ts";
export * from "./capabilities.ts";
export * from "./correlation.ts";
export * from "./cost-stamping.ts";
export * from "./errors.ts";
export * from "./events.ts";
export * from "./harness.ts";
export * from "./path-scope.ts";
export * from "./replay.ts";
export * from "./shell-gate.ts";
export * from "./subprocess.ts";
export * from "./tool-result.ts";

// Contract suite is a named subpath import (`@shamu/adapters-base/contract`)
// so test suites don't accidentally pull the scenarios into production code.
