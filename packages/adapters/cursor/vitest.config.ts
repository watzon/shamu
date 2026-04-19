import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: {
      junit: "./coverage/junit.xml",
    },
    // Live-vendor tests live under `test/live/*.live.test.ts` and opt in via
    // `SHAMU_CURSOR_LIVE=1`. Setting the env var flips the exclude off so the
    // live suite is picked up by `bun run test`; the suite itself gates each
    // case via `describe.skipIf(!LIVE)` for belt-and-braces.
    include: ["test/**/*.test.ts"],
    exclude: process.env.SHAMU_CURSOR_LIVE === "1" ? [] : ["test/live/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**", "**/dist/**"],
    },
  },
});
