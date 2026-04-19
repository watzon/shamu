import { defineConfig } from "vitest/config";

// Live-mode vendor tests live under `test/live/*.test.ts` and drive the real
// `@openai/codex-sdk` against a pre-authenticated local Codex CLI. They are
// gated behind `SHAMU_CODEX_LIVE=1` inside the test bodies via `describe.skip`,
// but we additionally exclude the live/ directory from default collection so
// a missing Codex CLI does not surface as "file import failed" noise in a
// routine test run. Set SHAMU_CODEX_LIVE=1 to opt in.
const SHAMU_CODEX_LIVE = process.env.SHAMU_CODEX_LIVE === "1";

export default defineConfig({
  test: {
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: {
      junit: "./coverage/junit.xml",
    },
    include: ["test/**/*.test.ts"],
    exclude: SHAMU_CODEX_LIVE
      ? ["**/node_modules/**", "**/dist/**"]
      : ["**/node_modules/**", "**/dist/**", "test/live/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**", "**/dist/**"],
    },
  },
});
