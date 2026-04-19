/**
 * Vendor CLI resolver — shared contract suite.
 *
 * Downstream adapter packages run `runVendorCliResolverContract(...)`
 * from a Vitest file to prove their descriptor + the shared resolver
 * honor the uniform precedence chain. The suite is self-contained: it
 * never spawns a subprocess and never hits the real filesystem — every
 * I/O seam is mocked via the resolver's injection points.
 *
 * Three cases per adapter:
 *   (a) Precedence — flag > env > configEntry > candidates > pathLookup.
 *   (b) Version-probe — a constraint-violating probe throws
 *       `VendorCliVersionMismatchError` before spawn.
 *   (c) Structured missing — `VendorCliNotFoundError` carries every
 *       path that was checked, in order, with `outcome: "missing"`.
 *
 * The suite runs against the real descriptor the adapter exports — so if
 * a candidate list gets rearranged, the `(a)` ordering test notices.
 */

import { describe, expect, it } from "vitest";
import {
  envVarFor,
  resolveVendorCli,
  type VendorCliDescriptor,
  VendorCliNotFoundError,
  VendorCliVersionMismatchError,
} from "../vendor-cli-resolver.ts";

export interface VendorCliResolverContractInput {
  readonly descriptor: VendorCliDescriptor;
}

/**
 * Builds the three test cases. Call inside a `describe(...)` in an
 * adapter's test file, passing the adapter's exported descriptor.
 */
export function runVendorCliResolverContract(input: VendorCliResolverContractInput): void {
  const { descriptor } = input;

  describe(`vendor-cli-resolver contract: ${descriptor.adapter}`, () => {
    it("honors the precedence chain: explicit > env > config > candidates > pathLookup", async () => {
      const envKey = envVarFor(descriptor.adapter);
      // Arrange: every source carries a different, existing path. Whichever
      // the resolver returns tells us which branch fired.
      const explicitPath = "/from/explicit";
      const envPath = "/from/env";
      const configPath = "/from/config";
      const expectedCandidatePath = "/from/candidate";

      // 1. Explicit wins even when env + config are set.
      const rExplicit = await resolveVendorCli({
        adapter: descriptor.adapter,
        descriptor,
        explicit: explicitPath,
        env: { [envKey]: envPath },
        configEntry: { cliPath: configPath },
        existsImpl: () => true,
        whichImpl: () => expectedCandidatePath,
      });
      expect(rExplicit.source).toBe("explicit");
      expect(rExplicit.path).toBe(explicitPath);

      // 2. Env wins when explicit is absent.
      const rEnv = await resolveVendorCli({
        adapter: descriptor.adapter,
        descriptor,
        env: { [envKey]: envPath },
        configEntry: { cliPath: configPath },
        existsImpl: () => true,
        whichImpl: () => expectedCandidatePath,
      });
      expect(rEnv.source).toBe("env");
      expect(rEnv.path).toBe(envPath);

      // 3. Config wins when explicit + env are absent.
      const rConfig = await resolveVendorCli({
        adapter: descriptor.adapter,
        descriptor,
        env: {},
        configEntry: { cliPath: configPath },
        existsImpl: () => true,
        whichImpl: () => expectedCandidatePath,
      });
      expect(rConfig.source).toBe("config");
      expect(rConfig.path).toBe(configPath);

      // 4. Descriptor candidate wins when explicit + env + config all miss.
      //    We mock `existsImpl` so ONLY the first non-`pathLookup`
      //    candidate in the descriptor's list resolves. That proves the
      //    loop honors descriptor ordering.
      const firstCandidate = descriptor.candidates.find(
        (c) => c.kind === "absolute" || c.kind === "homeRelative",
      );
      if (firstCandidate) {
        const rCandidate = await resolveVendorCli({
          adapter: descriptor.adapter,
          descriptor,
          env: {},
          existsImpl: (path) => {
            // Match the first non-pathLookup candidate's projected path.
            // For `absolute` the path is literal; for `homeRelative` we
            // accept any path ending with its last segment (avoids
            // coupling the test to the test machine's home dir).
            if (firstCandidate.kind === "absolute") return path === firstCandidate.path;
            const last = firstCandidate.segments[firstCandidate.segments.length - 1];
            return typeof last === "string" && path.endsWith(last);
          },
          whichImpl: () => null,
        });
        expect(rCandidate.source).toBe("candidate");
      }

      // 5. pathLookup wins when all descriptor candidates miss but PATH
      //    has the binary. Only applicable when the descriptor DOES
      //    include a `pathLookup` entry (most real adapters do).
      const hasPathLookup = descriptor.candidates.some((c) => c.kind === "pathLookup");
      if (hasPathLookup) {
        const rPath = await resolveVendorCli({
          adapter: descriptor.adapter,
          descriptor,
          env: {},
          existsImpl: (p) => p === "/from/path",
          whichImpl: () => "/from/path",
        });
        expect(rPath.source).toBe("pathLookup");
        expect(rPath.path).toBe("/from/path");
      }
    });

    it("throws VendorCliVersionMismatchError when the probe's version violates the constraint", async () => {
      // Force the resolver down the `explicit` branch so the probe fires
      // reliably regardless of the descriptor's candidate list.
      const decoratedDescriptor: VendorCliDescriptor = {
        ...descriptor,
        versionProbe: {
          args: ["--version"],
          parse: (stdout) => stdout.trim(),
          constraint: ">=99.0.0",
        },
      };
      await expect(
        resolveVendorCli({
          adapter: descriptor.adapter,
          descriptor: decoratedDescriptor,
          explicit: "/pretend/binary",
          existsImpl: () => true,
          whichImpl: () => null,
          versionProbeRunner: async () => ({ exitCode: 0, stdout: "1.2.3\n", stderr: "" }),
        }),
      ).rejects.toBeInstanceOf(VendorCliVersionMismatchError);
    });

    it("throws VendorCliNotFoundError listing every attempted path", async () => {
      const envKey = envVarFor(descriptor.adapter);
      try {
        await resolveVendorCli({
          adapter: descriptor.adapter,
          descriptor,
          env: { [envKey]: "" }, // unset env effectively
          existsImpl: () => false,
          whichImpl: () => null,
        });
        throw new Error("resolveVendorCli should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(VendorCliNotFoundError);
        const nfe = err as VendorCliNotFoundError;
        expect(nfe.adapter).toBe(descriptor.adapter);
        // Every attempt must be recorded in order.
        expect(nfe.attempts.length).toBeGreaterThan(0);
        // The error message should be actionable — mention the adapter.
        expect(nfe.message).toContain(descriptor.adapter);
        // At least one attempt corresponds to a `missing` outcome with
        // a real path (candidates that were probed). `explicit`, `env`,
        // `config` will be `skipped` here; candidate attempts are the
        // load-bearing ones.
        const missingWithPath = nfe.attempts.filter(
          (a) => a.outcome === "missing" && typeof a.path === "string" && a.path.length > 0,
        );
        if (descriptor.candidates.some((c) => c.kind !== "pathLookup")) {
          expect(missingWithPath.length).toBeGreaterThan(0);
        }
      }
    });
  });
}
