/**
 * `containerEgressPreflight` — pre-opt-in readiness check for the
 * container-backed broker.
 *
 * `shamu doctor` (track 8.C.1) calls this when the operator asks about
 * container egress; it's also a useful standalone entry for scripted
 * provisioning. The check is strictly non-destructive — we never create
 * networks, pull images, or leave any state behind.
 *
 * Checks performed (in order):
 *   1. `docker version` succeeds → daemon reachable.
 *   2. `docker image inspect <image>` OR `docker manifest inspect <image>` →
 *      image is either present locally or resolvable from the configured
 *      registry. (A missing manifest + missing local image is a hard fail;
 *      the operator has to build/pull before opting in.)
 *   3. `docker ps -a --filter name=shamu-egress-` → no stale containers
 *      from a prior crash. Stale containers are advisory, not fatal in
 *      terms of functionality, but they pollute `docker ps` output and
 *      can collide with new container names on a fast restart — we report
 *      them so the operator can decide.
 *
 * Returns a structured result rather than throwing. Consumers render their
 * own error messages (the `shamu doctor` UI wants stable reason strings).
 */

import { spawn } from "node:child_process";
import {
  type ContainerEgressPreflightResult,
  DEFAULT_SIDECAR_IMAGE,
  type DockerInvoker,
} from "./types.ts";

const STALE_CONTAINER_NAME_PREFIX = "shamu-egress-";

/** Tiny production invoker — same shape as the one in `container.ts`. */
function defaultInvoker(dockerPath: string): DockerInvoker {
  return (args, options) =>
    new Promise((resolve) => {
      const proc = spawn(dockerPath, args as string[], { stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timer: NodeJS.Timeout | null = null;
      let timedOut = false;
      proc.stdout?.on("data", (c: Buffer) => stdout.push(c));
      proc.stderr?.on("data", (c: Buffer) => stderr.push(c));
      proc.on("error", (err) => {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: `${Buffer.concat(stderr).toString("utf8")}spawn error: ${err.message}`,
          exitCode: 127,
        });
      });
      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: timedOut
            ? `${Buffer.concat(stderr).toString("utf8")}\n<invoker: timeout>`
            : Buffer.concat(stderr).toString("utf8"),
          exitCode: code ?? 1,
        });
      });
      if (options?.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            proc.kill("SIGTERM");
          } catch {
            // ignore
          }
        }, options.timeoutMs);
      }
    });
}

export interface ContainerEgressPreflightOptions {
  /** Docker binary path. Defaults to `"docker"`. */
  readonly dockerPath?: string;
  /** Image to check for. Defaults to `DEFAULT_SIDECAR_IMAGE`. */
  readonly image?: string;
  /** Test seam. Same shape as `ContainerEgressBrokerOptions.dockerInvoker`. */
  readonly dockerInvoker?: DockerInvoker;
}

/**
 * Run the three-step preflight. Never throws — returns a typed diagnostic.
 */
export async function containerEgressPreflight(
  opts: ContainerEgressPreflightOptions = {},
): Promise<ContainerEgressPreflightResult> {
  const dockerPath = opts.dockerPath ?? "docker";
  const image = opts.image ?? DEFAULT_SIDECAR_IMAGE;
  const invoker: DockerInvoker = opts.dockerInvoker ?? defaultInvoker(dockerPath);

  // 1. Daemon reachable?
  const version = await invoker(["version", "--format", "{{.Server.Version}}"], {
    timeoutMs: 5000,
  });
  if (version.exitCode !== 0) {
    const firstLine = version.stderr.trim().split("\n", 1)[0] ?? "";
    return {
      ok: false,
      reason: "docker_unreachable",
      detail: firstLine.length > 0 ? firstLine : `docker exited ${version.exitCode}`,
    };
  }

  // 2. Image present locally, or resolvable via registry?
  const localImage = await invoker(["image", "inspect", image], { timeoutMs: 5000 });
  let imageOk = localImage.exitCode === 0;
  if (!imageOk) {
    const manifest = await invoker(["manifest", "inspect", image], { timeoutMs: 10000 });
    imageOk = manifest.exitCode === 0;
    if (!imageOk) {
      // Prefer the manifest stderr — it's the more informative message
      // ("no such manifest" vs "Cannot connect to registry").
      const detailSource = manifest.stderr.trim().length > 0 ? manifest.stderr : localImage.stderr;
      const firstLine = detailSource.trim().split("\n", 1)[0] ?? "";
      return {
        ok: false,
        reason: "image_missing",
        detail:
          firstLine.length > 0
            ? `${image} not present locally and not resolvable: ${firstLine}`
            : `${image} not present locally and not resolvable`,
      };
    }
  }

  // 3. Any stale containers from a prior crash?
  const staleCheck = await invoker(
    ["ps", "-a", "--filter", `name=${STALE_CONTAINER_NAME_PREFIX}`, "--format", "{{.Names}}"],
    { timeoutMs: 5000 },
  );
  if (staleCheck.exitCode !== 0) {
    const firstLine = staleCheck.stderr.trim().split("\n", 1)[0] ?? "";
    return {
      ok: false,
      reason: "network_error",
      detail: firstLine.length > 0 ? firstLine : `docker ps exited ${staleCheck.exitCode}`,
    };
  }
  const names = staleCheck.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (names.length > 0) {
    return {
      ok: false,
      reason: "stale_containers",
      detail: `stale shamu-egress containers present: ${names.join(", ")}`,
    };
  }

  return { ok: true };
}
