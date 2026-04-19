import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: {
      junit: "./coverage/junit.xml",
    },
    // Live-vendor tests live under `test/live/*.live.test.ts` and opt in via
    // `SHAMU_AMP_LIVE=1`. The default include excludes them.
    include: ["test/**/*.test.ts"],
    exclude: ["test/live/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**", "**/dist/**"],
    },
  },
});
