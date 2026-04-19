import { defineConfig } from "vitest/config";

/**
 * Opt-in vitest config for the live-vendor smoke tests. Invoke with:
 *   SHAMU_PI_LIVE=1 bun run vitest run --config vitest.live.config.ts
 *
 * The default `vitest.config.ts` excludes `test/live/**`; this one flips
 * the inclusion so the live file is the only one picked up. Both live
 * side-by-side so CI / dev workflows that collect the default config
 * never accidentally run vendor-dependent smokes.
 */
export default defineConfig({
  test: {
    include: ["test/live/**/*.test.ts"],
    testTimeout: 180_000,
  },
});
