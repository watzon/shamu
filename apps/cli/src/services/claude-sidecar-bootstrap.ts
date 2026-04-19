/**
 * Resolve the Claude CLI path for a given run, threading the four-source
 * precedence the CLI promises:
 *
 *   1. Explicit override (`--claude-cli <path>` on `shamu run`).
 *   2. `$CLAUDE_CLI_PATH` environment variable.
 *   3. Sidecar bootstrap — `ensureClaudeSidecar()` from
 *      `@shamu/adapter-claude`, which lazy-downloads the pinned Claude
 *      binary on first run.
 *   4. PATH fallback — return `null` and let the vendor SDK's default
 *      lookup (which ultimately consults `PATH`) run.
 *
 * The returned `source` field lets callers emit a diag explaining which
 * branch fired, which is what `shamu doctor` (sibling track 8.C.1) will
 * surface to the operator. See the parallel 8.C.1 track for the doctor-
 * side wiring — this module stays out of `doctor.ts` so the two tracks
 * can land independently.
 */

import type { EnsureClaudeSidecarOptions, EnsureClaudeSidecarResult } from "@shamu/adapter-claude";

export type ClaudeCliSource = "explicit" | "env" | "sidecar" | "path";

export interface ResolveClaudeCliResult {
  /** Which branch of the precedence chain fired. */
  readonly source: ClaudeCliSource;
  /**
   * Path to the Claude CLI binary. For `source: "path"` this is `null`;
   * the caller should pass the SpawnOpts through without `vendorCliPath`
   * and let the SDK resolve the binary via `PATH`.
   */
  readonly path: string | null;
  /**
   * Version string reported by the sidecar resolver. Only populated for
   * `source: "sidecar"`; `undefined` otherwise. Useful for diags.
   */
  readonly version?: string;
}

export interface ResolveClaudeCliInput {
  readonly explicit?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Injection seam — production passes the real
   * `ensureClaudeSidecar` from `@shamu/adapter-claude`; unit tests pass
   * a scripted fake.
   */
  readonly ensureSidecar?: (opts: EnsureClaudeSidecarOptions) => Promise<EnsureClaudeSidecarResult>;
  /**
   * If `ensureSidecar` throws, by default we fall through to PATH (so a
   * bad network doesn't break a developer with `claude` already on PATH).
   * Tests pass `false` to see the error.
   */
  readonly fallthroughOnSidecarError?: boolean;
  /**
   * Optional diag hook for bootstrap failures. The CLI wires this to
   * `writeDiag` so the operator sees why the fall-through happened.
   */
  readonly onSidecarError?: (err: unknown) => void;
}

export async function resolveClaudeCliPath(
  input: ResolveClaudeCliInput = {},
): Promise<ResolveClaudeCliResult> {
  const env = input.env ?? process.env;

  // 1. Explicit override.
  if (input.explicit && input.explicit.length > 0) {
    return { source: "explicit", path: input.explicit };
  }

  // 2. Env var.
  const envPath = env.CLAUDE_CLI_PATH;
  if (envPath && envPath.length > 0) {
    return { source: "env", path: envPath };
  }

  // 3. Sidecar bootstrap.
  if (input.ensureSidecar) {
    try {
      const out = await input.ensureSidecar({});
      return { source: "sidecar", path: out.path, version: out.version };
    } catch (err) {
      if (input.fallthroughOnSidecarError === false) {
        throw err;
      }
      input.onSidecarError?.(err);
    }
  }

  // 4. PATH fallback.
  return { source: "path", path: null };
}
