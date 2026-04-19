/**
 * Claude "sidecar" binary bootstrap.
 *
 * Shamu ships as a single Bun-compiled binary (see
 * `scripts/build-release.ts`), but the Claude Agent SDK subprocess-spawns a
 * ~200MB per-platform `claude` CLI that `bun build --compile` cannot
 * absorb (documented in `docs/phase-0/bun-compat.md` Test 3). On first
 * run, `ensureClaudeSidecar()` resolves a valid path to that binary —
 * either a user-supplied override, an env-var pointer, or a cached copy
 * downloaded from a pinned URL and SHA-verified against the manifest in
 * `sidecar-pins.ts`.
 *
 * Resolution precedence:
 *   1. Explicit `opts.path`.
 *   2. `$SHAMU_CLAUDE_SIDECAR_PATH` environment variable.
 *   3. Cached `<cacheDir>/<version>/claude` if SHA256 matches the pin.
 *   4. Download from `SIDECAR_DOWNLOAD_URL_TEMPLATE` (retry 3×, 1/4/9s),
 *      verify SHA256, atomic-rename into place.
 *
 * Cache-dir strategy (mirrors other adapters' `XDG_CACHE_HOME` handling,
 * see `packages/adapters/{cursor,gemini,amp,pi}/src/driver.ts`):
 *   - darwin: `~/Library/Caches/shamu/claude-sidecar/<version>/`
 *   - linux:  `$XDG_CACHE_HOME/shamu/claude-sidecar/<version>/`, falling
 *             back to `~/.cache/shamu/claude-sidecar/<version>/`.
 *
 * Atomic placement: writes go to `<cacheDir>/.partial-<uuid>`, are
 * SHA-verified, then `fs.renameSync`-ed over the final path. Interrupts
 * during a download leave only the `.partial-*` file, which a later call
 * ignores.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SIDECAR_DOWNLOAD_URL_TEMPLATE,
  SIDECAR_PINS,
  SIDECAR_VERSION,
  type SidecarPlatform,
} from "./sidecar-pins.ts";

/**
 * Retry schedule: 3 attempts, then give up. Delays are in milliseconds.
 * Chosen to front-load a fast retry for transient packet loss (1s), then
 * give the upstream CDN a longer window for a slower transient (4s, 9s).
 * Total worst-case wall is ~14s across 3 attempts, which stays well under
 * typical CLI boot-time budgets.
 */
const RETRY_DELAYS_MS = [1000, 4000, 9000] as const;

export interface EnsureClaudeSidecarOptions {
  /**
   * Hard override. If provided, bypasses env/cache/download; the path is
   * verified to exist but NOT SHA-checked (the caller owns pinning here).
   */
  readonly path?: string;
  /**
   * If true, re-download even when a cached copy exists and passes SHA.
   * Intended for `shamu doctor --refresh-sidecar` (not yet wired).
   */
  readonly force?: boolean;
  /**
   * Inject a fetch implementation. Defaults to the global `fetch`.
   */
  readonly fetchFn?: FetchFn;
  /**
   * Override the platform detection. Tests inject a fixed value so the
   * same unit test runs on macOS CI and Linux CI.
   */
  readonly platform?: SidecarPlatform;
  /**
   * Override the cache directory. Primarily for tests; the production
   * call uses the XDG/Library-Caches resolution in `defaultCacheRoot`.
   */
  readonly cacheRoot?: string;
  /** Access to a pluggable filesystem for tests. */
  readonly fsImpl?: SidecarFs;
  /** Access to the environment (tests inject a clean object). */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Sleep hook — test seam that lets unit tests skip real wall-time
   * waits in the retry loop. Defaults to a `setTimeout` promise.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Override the pin table lookup for this call. Intended for unit tests
   * only — the shipped `SIDECAR_PINS` map is `Object.freeze`-d and must
   * stay a placeholder until the release-automation pipeline regenerates
   * it, but tests need to verify the positive cache-hit path against
   * a real SHA they've just computed. Production callers leave this
   * undefined.
   */
  readonly expectedSha?: string;
}

export interface EnsureClaudeSidecarResult {
  readonly path: string;
  readonly version: string;
}

export type FetchFn = (
  url: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface SidecarFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): Uint8Array;
  writeFileSync(path: string, data: Uint8Array): void;
  mkdirSync(path: string, options: { recursive: true }): void;
  renameSync(oldPath: string, newPath: string): void;
  chmodSync(path: string, mode: number): void;
  unlinkSync(path: string): void;
  statSync(path: string): { isFile(): boolean; size: number };
}

const DEFAULT_FS: SidecarFs = {
  existsSync,
  readFileSync: (p) => readFileSync(p),
  writeFileSync: (p, data) => writeFileSync(p, data),
  mkdirSync: (p, o) => {
    mkdirSync(p, o);
  },
  renameSync,
  chmodSync,
  unlinkSync,
  statSync: (p) => statSync(p),
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The main entry. Returns a valid Claude CLI path or throws with an
 * actionable message. Designed to be safe to call from the CLI bootstrap
 * on every `--adapter=claude` run — when the cached copy is valid, the
 * only I/O is an existsSync + readFileSync + hash.
 */
export async function ensureClaudeSidecar(
  opts: EnsureClaudeSidecarOptions = {},
): Promise<EnsureClaudeSidecarResult> {
  const fsImpl = opts.fsImpl ?? DEFAULT_FS;
  const envRef = opts.env ?? process.env;
  const sleep = opts.sleep ?? defaultSleep;
  const fetchFn = opts.fetchFn ?? (globalThis.fetch as FetchFn | undefined);

  // 1. Explicit override.
  if (opts.path) {
    if (!fsImpl.existsSync(opts.path)) {
      throw new Error(`ensureClaudeSidecar: explicit path '${opts.path}' does not exist`);
    }
    return { path: opts.path, version: SIDECAR_VERSION };
  }

  // 2. Env var.
  const envPath = envRef.SHAMU_CLAUDE_SIDECAR_PATH;
  if (envPath && envPath.length > 0) {
    if (!fsImpl.existsSync(envPath)) {
      throw new Error(
        `ensureClaudeSidecar: SHAMU_CLAUDE_SIDECAR_PATH points to '${envPath}' which does not exist`,
      );
    }
    return { path: envPath, version: SIDECAR_VERSION };
  }

  // 3. Cache hit.
  const platform = opts.platform ?? detectPlatform();
  const expectedSha = opts.expectedSha ?? SIDECAR_PINS[platform];
  if (!expectedSha) {
    throw new Error(
      `ensureClaudeSidecar: no pinned SHA256 for platform '${platform}'; supported platforms are ${Object.keys(SIDECAR_PINS).join(", ")}`,
    );
  }
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot(platform, envRef);
  const versionDir = join(cacheRoot, SIDECAR_VERSION);
  const finalPath = join(versionDir, "claude");

  if (!opts.force && fsImpl.existsSync(finalPath)) {
    const actualSha = sha256Hex(fsImpl.readFileSync(finalPath));
    if (actualSha === expectedSha) {
      return { path: finalPath, version: SIDECAR_VERSION };
    }
    // Silent fall-through: the cached binary is corrupted or stale.
    // Wipe it so the download below can't collide with the stale copy.
    try {
      fsImpl.unlinkSync(finalPath);
    } catch {
      // best-effort; the rename at the end will overwrite either way
    }
  }

  // 4. Download with retry.
  if (!fetchFn) {
    throw new Error(
      "ensureClaudeSidecar: no fetch implementation available (runtime did not provide global fetch and no fetchFn was injected)",
    );
  }

  fsImpl.mkdirSync(versionDir, { recursive: true });
  const url = resolveDownloadUrl(platform);
  const buffer = await downloadWithRetry({
    url,
    fetchFn,
    sleep,
  });
  const actualSha = sha256Hex(buffer);
  if (actualSha !== expectedSha) {
    throw new Error(
      `ensureClaudeSidecar: SHA256 mismatch for ${platform} sidecar; expected=${expectedSha} actual=${actualSha} ` +
        `(url=${url}). Refusing to install; the release-automation pipeline may have published a new artifact without regenerating ` +
        `packages/adapters/claude/src/sidecar-pins.ts.`,
    );
  }

  // Atomic placement.
  const partialPath = join(versionDir, `.partial-${randomUUID()}`);
  fsImpl.writeFileSync(partialPath, buffer);
  fsImpl.chmodSync(partialPath, 0o755);
  fsImpl.renameSync(partialPath, finalPath);

  return { path: finalPath, version: SIDECAR_VERSION };
}

// --- helpers --------------------------------------------------------------

function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Detect the current platform in the slug shape our pins file uses
 * (`<os>-<arch>`). Narrow the result to `SidecarPlatform`; anything else
 * throws so we get a loud error instead of a mysterious download failure.
 */
function detectPlatform(): SidecarPlatform {
  const plat = process.platform;
  const arch = process.arch;
  const slug = `${plat}-${arch}`;
  if (slug === "darwin-arm64" || slug === "linux-x64") return slug;
  throw new Error(
    `ensureClaudeSidecar: unsupported host platform '${slug}'; supported: darwin-arm64, linux-x64`,
  );
}

/**
 * Compute the per-platform default cache root. See module header for the
 * XDG/Library-Caches rationale; we mirror the handling in the
 * Cursor/Gemini/Amp/Pi adapter env allow-lists.
 */
function defaultCacheRoot(platform: SidecarPlatform, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin-arm64") {
    return join(homedir(), "Library", "Caches", "shamu", "claude-sidecar");
  }
  // linux-x64
  const xdg = env.XDG_CACHE_HOME;
  if (xdg && xdg.length > 0) {
    return join(xdg, "shamu", "claude-sidecar");
  }
  return join(homedir(), ".cache", "shamu", "claude-sidecar");
}

function resolveDownloadUrl(platform: SidecarPlatform): string {
  const [os, arch] = platform.split("-") as [string, string];
  return SIDECAR_DOWNLOAD_URL_TEMPLATE.replace("{version}", SIDECAR_VERSION)
    .replace("{os}", os)
    .replace("{arch}", arch);
}

interface DownloadInput {
  readonly url: string;
  readonly fetchFn: FetchFn;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * Attempt a download up to three times, with exponential-ish backoff.
 * The retry loop is intentionally simple: no jitter, no conditional retry
 * on specific HTTP codes. Every non-2xx (or any thrown `fetch`) counts
 * as a retry; after the last attempt we throw with the accumulated error
 * list.
 */
async function downloadWithRetry(input: DownloadInput): Promise<Uint8Array> {
  const errors: string[] = [];
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 0;
      await input.sleep(delay);
    }
    try {
      const res = await input.fetchFn(input.url);
      if (!res.ok) {
        errors.push(
          `attempt ${attempt + 1}: HTTP ${res.status} ${res.statusText} from ${input.url}`,
        );
        continue;
      }
      const ab = await res.arrayBuffer();
      return new Uint8Array(ab);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`attempt ${attempt + 1}: ${message}`);
    }
  }
  throw new Error(
    `ensureClaudeSidecar: download failed after ${RETRY_DELAYS_MS.length} attempts (url=${input.url}):\n  ${errors.join("\n  ")}`,
  );
}
