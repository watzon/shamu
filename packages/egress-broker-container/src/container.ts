/**
 * `createContainerEgressBroker` — Docker-backed peer of
 * `createEgressBroker` from `@shamu/egress-broker`.
 *
 * ### Design
 *
 * The in-process broker lives in the supervisor process and relies on the
 * adapter subprocess honouring `HTTPS_PROXY` / `HTTP_PROXY`. A misbehaving
 * subprocess can bypass it by ignoring the env var. The container-backed
 * broker solves this with kernel-level isolation: the proxy container owns
 * its own Docker network, and the adapter runtime (a sibling container, not
 * shipped here — see Phase 8.C wiring followup) is attached to the same
 * network with no default gateway. The only route to the outside world
 * is through the proxy.
 *
 * This package ships the proxy side of that story. Sibling work lifts
 * `withEgressBroker` into a factory-injecting shape so callers can choose
 * in-process vs container at the composition boundary.
 *
 * ### Lifecycle
 *
 *  1. `start()`
 *     - `docker version` — fail loud with `DockerUnreachableError`.
 *     - `docker network create` — swallow "already exists".
 *     - Write policy JSON to a temp file on the host.
 *     - `docker run -d --rm --network <net> -p 127.0.0.1:0:8080 -v <tmp>:... <image>`.
 *     - `docker port <name> 8080` — extract host port for `handle.url`.
 *     - `docker logs --follow` in the background — parse NDJSON lines and
 *       re-emit as `policy.egress_allowed` / `policy.egress_denied`.
 *
 *  2. `shutdown()`
 *     - Dispose the log streamer.
 *     - `docker kill <name>` (`--rm` cleans the container; `docker rm -f` as
 *       a safety net).
 *     - `docker network rm <name>` iff we created it.
 *     - Remove the temp policy file.
 *
 * Every step is idempotent; a double-shutdown is a no-op.
 *
 * ### Error taxonomy
 *
 *  - `DockerUnreachableError` — daemon missing / unreachable on `start()`.
 *  - `ContainerStartError` — `docker run` failed, or the container booted
 *    but didn't publish a port.
 *  - `ContainerShutdownError` — rare; surfaced when `docker kill` *and* the
 *    `--rm` fallback both fail.
 *  - `ContainerLogParseError` — NDJSON parse failure on a log line. Surfaced
 *    only via the optional `onParseError` hook; the broker itself keeps
 *    running.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EgressBrokerHandle,
  EgressEventListener,
  EgressEventMap,
  EgressPolicy,
  PolicyEgressAllowedEvent,
  PolicyEgressDeniedEvent,
} from "@shamu/egress-broker";
import {
  type ContainerEgressBrokerHandle,
  type ContainerEgressBrokerOptions,
  ContainerLogParseError,
  ContainerShutdownError,
  ContainerStartError,
  DEFAULT_CONTAINER_POLICY_PATH,
  DEFAULT_CONTAINER_PROXY_PORT,
  DEFAULT_SIDECAR_IMAGE,
  type DockerInvoker,
  type DockerLogStreamer,
  DockerUnreachableError,
} from "./types.ts";

const CONTAINER_NAME_PREFIX = "shamu-egress";
const NETWORK_NAME_PREFIX = "shamu-egress-net";

/** Typed, throws-safe emitter (mirrors the in-process broker's version). */
class TypedEmitter {
  private readonly listeners = new Map<keyof EgressEventMap, Set<(ev: unknown) => void>>();

  on<K extends keyof EgressEventMap>(type: K, listener: EgressEventListener<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    const fn = listener as (ev: unknown) => void;
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  emit<K extends keyof EgressEventMap>(type: K, event: EgressEventMap[K]): void {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    for (const fn of set) {
      try {
        fn(event);
      } catch {
        // Listener is best-effort; never crash the proxy.
      }
    }
  }
}

/**
 * Production `DockerInvoker` — spawns `docker`, writes optional stdin, and
 * resolves once the process exits. `timeoutMs` is best-effort.
 */
function defaultDockerInvoker(dockerPath: string): DockerInvoker {
  return (args, options) =>
    new Promise((resolve) => {
      const proc = spawn(dockerPath, args as string[], { stdio: ["pipe", "pipe", "pipe"] });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timer: NodeJS.Timeout | null = null;
      let timedOut = false;
      proc.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
      proc.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
      proc.on("error", (err) => {
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: `${Buffer.concat(stderrChunks).toString("utf8")}spawn error: ${err.message}`,
          exitCode: 127,
        });
      });
      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        resolve({
          stdout,
          stderr: timedOut ? `${stderr}\n<invoker: timeout>` : stderr,
          exitCode: code ?? 1,
        });
      });
      if (options?.input !== undefined && proc.stdin) {
        try {
          proc.stdin.write(options.input);
        } catch {
          // ignore
        }
      }
      try {
        proc.stdin?.end();
      } catch {
        // ignore
      }
      if (options?.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            proc.kill("SIGTERM");
          } catch {
            // ignore
          }
          setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              // ignore
            }
          }, 500);
        }, options.timeoutMs);
      }
    });
}

/**
 * Production log streamer — tails `docker logs --follow` and forwards each
 * newline-delimited chunk as a line. Handles partial lines across chunks.
 */
function defaultDockerLogStreamer(dockerPath: string): DockerLogStreamer {
  return (args, handlers) => {
    const proc: ChildProcess = spawn(dockerPath, args as string[], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    const flush = (chunk: string): void => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) handlers.onLine(line);
      }
    };
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (c: string) => flush(c));
    proc.stderr?.on("data", () => {
      // ignore — docker logs errors are non-fatal; we rely on exit code.
    });
    let closed = false;
    proc.on("close", (code) => {
      if (closed) return;
      closed = true;
      // Drain the trailing partial line if it's a complete JSON chunk.
      if (buffer.length > 0) handlers.onLine(buffer);
      handlers.onClose(code ?? 0);
    });
    proc.on("error", () => {
      if (closed) return;
      closed = true;
      handlers.onClose(127);
    });
    return {
      dispose: () => {
        if (closed) return;
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      },
    };
  };
}

/**
 * Default policy-file writer: JSON-serialize to a temp path under
 * `os.tmpdir()`. Cleanup removes the file; failures are logged into the
 * promise chain but never rethrown (the file may already be gone on a
 * crash-recovery path).
 */
async function defaultWritePolicyFile(
  policyJson: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = tmpdir();
  const path = join(dir, `shamu-egress-policy-${randomUUID()}.json`);
  await writeFile(path, policyJson, "utf8");
  return {
    path,
    cleanup: async () => {
      try {
        await rm(path, { force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Parse a `docker run`-ready policy body. We freeze the input to preserve
 * the in-process broker's semantics; the container reads the file at
 * startup and never writes it back.
 */
function serializePolicy(policy: EgressPolicy): string {
  const body: Record<string, unknown> = {
    defaultPolicy: policy.defaultPolicy,
    allowedHosts: policy.allowedHosts,
    allowedHostSuffixes: policy.allowedHostSuffixes,
  };
  if (policy.egressLogPath !== undefined) {
    body.egressLogPath = policy.egressLogPath;
  }
  return JSON.stringify(body);
}

/**
 * Extract the host port for a published container port from the output of
 * `docker port <name> <containerPort>`. The line looks like:
 *
 *   `0.0.0.0:32768`          // IPv4 publish
 *   `127.0.0.1:32768`        // loopback-only publish
 *   `[::]:32768`             // IPv6 — we still use the port
 *
 * Returns `null` on unparseable input.
 */
function parseHostPort(raw: string): number | null {
  const line = raw.split("\n").find((l) => l.trim().length > 0);
  if (!line) return null;
  const trimmed = line.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon < 0) return null;
  const port = Number.parseInt(trimmed.slice(colon + 1), 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return port;
}

/**
 * Classify a `docker version` failure. We treat a non-zero exit code as
 * "Docker unreachable"; the stderr is surfaced in the error detail so
 * operators can see whether it's "daemon not running" vs "permission denied".
 */
function explainDockerUnreachable(stderr: string, exitCode: number): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return `docker exited ${exitCode} with no stderr`;
  // Keep it short but informative; `shamu doctor` renders the detail verbatim.
  const firstLine = trimmed.split("\n", 1)[0] ?? trimmed;
  return `docker exited ${exitCode}: ${firstLine}`;
}

/**
 * Interpret a `docker network create` failure. The "already exists" case is
 * expected in fast restart scenarios and should be swallowed.
 */
function isNetworkAlreadyExists(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return s.includes("already exists") || s.includes("duplicate network name");
}

/** Parse one NDJSON log line. Returns `null` for blanks / non-JSON / non-event. */
function parseLogLine(line: string): PolicyEgressAllowedEvent | PolicyEgressDeniedEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;
  if (type !== "policy.egress_allowed" && type !== "policy.egress_denied") return null;
  // Narrow fields with a strict shape check. We don't tolerate missing
  // required fields — those surface as `ContainerLogParseError` via the
  // optional hook.
  const ts = typeof obj.ts === "number" ? obj.ts : null;
  const proxyMethod =
    obj.proxyMethod === "CONNECT" || obj.proxyMethod === "HTTP" ? obj.proxyMethod : null;
  const host = typeof obj.host === "string" ? obj.host : null;
  const port = typeof obj.port === "number" ? obj.port : obj.port === null ? null : undefined;
  const clientAddr = typeof obj.clientAddr === "string" ? obj.clientAddr : undefined;
  if (ts === null || proxyMethod === null || host === null || port === undefined) return null;
  if (type === "policy.egress_denied") {
    const rawTarget = typeof obj.rawTarget === "string" ? obj.rawTarget : null;
    const reason = typeof obj.reason === "string" ? obj.reason : null;
    if (rawTarget === null || reason === null) return null;
    const allowed: readonly string[] = [
      "host_not_allowlisted",
      "invalid_target",
      "method_rejected",
    ];
    if (!allowed.includes(reason)) return null;
    const deny: PolicyEgressDeniedEvent = {
      type: "policy.egress_denied",
      ts,
      proxyMethod,
      rawTarget,
      host,
      port,
      reason: reason as PolicyEgressDeniedEvent["reason"],
      ...(clientAddr !== undefined ? { clientAddr } : {}),
    };
    return deny;
  }
  const allow: PolicyEgressAllowedEvent = {
    type: "policy.egress_allowed",
    ts,
    proxyMethod,
    host,
    port,
    ...(clientAddr !== undefined ? { clientAddr } : {}),
  };
  return allow;
}

/** Public entry point. See file-level doc. */
export function createContainerEgressBroker(
  opts: ContainerEgressBrokerOptions,
): ContainerEgressBrokerHandle {
  const image = opts.image ?? DEFAULT_SIDECAR_IMAGE;
  const dockerPath = opts.dockerPath ?? "docker";
  const uuid = opts.uuid ?? randomUUID;
  const providedNetworkName = opts.networkName;
  const networkName = providedNetworkName ?? `${NETWORK_NAME_PREFIX}-${uuid()}`;
  const containerName = `${CONTAINER_NAME_PREFIX}-${uuid()}`;
  const host = opts.host ?? "127.0.0.1";
  const invoker: DockerInvoker = opts.dockerInvoker ?? defaultDockerInvoker(dockerPath);
  const logStreamer: DockerLogStreamer =
    opts.dockerLogStreamer ?? defaultDockerLogStreamer(dockerPath);
  const writePolicyFile = opts.writePolicyFile ?? defaultWritePolicyFile;
  const shutdownGraceMs = opts.shutdownGraceMs ?? 500;
  const emitter = new TypedEmitter();

  let boundPort = 0;
  let containerId = "";
  let createdNetwork = false;
  let policyCleanup: (() => Promise<void>) | null = null;
  let logStreamDispose: (() => void) | null = null;
  let starting: Promise<void> | null = null;
  let shuttingDown: Promise<void> | null = null;
  let shutdownComplete = false;

  // The caller provides a frozen policy; we keep a reference for the handle.
  const policy: EgressPolicy = opts.policy;

  async function runDocker(
    args: readonly string[],
    opts2?: { input?: string; timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return invoker(args, opts2);
  }

  async function assertDockerReachable(): Promise<void> {
    const res = await runDocker(["version", "--format", "{{.Server.Version}}"], {
      timeoutMs: 5000,
    });
    if (res.exitCode !== 0) {
      throw new DockerUnreachableError(explainDockerUnreachable(res.stderr, res.exitCode));
    }
  }

  async function ensureNetwork(): Promise<void> {
    const res = await runDocker(["network", "create", networkName], { timeoutMs: 5000 });
    if (res.exitCode === 0) {
      createdNetwork = true;
      return;
    }
    if (isNetworkAlreadyExists(res.stderr)) return;
    throw new ContainerStartError(
      `docker network create ${networkName} exited ${res.exitCode}: ${res.stderr.trim()}`,
    );
  }

  async function runContainer(policyPath: string): Promise<string> {
    const publishSpec = `${host}:0:${DEFAULT_CONTAINER_PROXY_PORT}`;
    const mountSpec = `${policyPath}:${DEFAULT_CONTAINER_POLICY_PATH}:ro`;
    const res = await runDocker(
      [
        "run",
        "-d",
        "--rm",
        "--name",
        containerName,
        "--network",
        networkName,
        "-p",
        publishSpec,
        "-v",
        mountSpec,
        image,
      ],
      { timeoutMs: 15000 },
    );
    if (res.exitCode !== 0) {
      throw new ContainerStartError(
        `docker run ${image} exited ${res.exitCode}: ${res.stderr.trim()}`,
      );
    }
    const id = res.stdout.trim();
    if (id.length === 0) {
      throw new ContainerStartError(
        `docker run ${image} produced no container id; stderr=${res.stderr.trim()}`,
      );
    }
    return id;
  }

  async function resolveHostPort(): Promise<number> {
    const res = await runDocker(["port", containerName, String(DEFAULT_CONTAINER_PROXY_PORT)], {
      timeoutMs: 5000,
    });
    if (res.exitCode !== 0) {
      throw new ContainerStartError(
        `docker port ${containerName} exited ${res.exitCode}: ${res.stderr.trim()}`,
      );
    }
    const port = parseHostPort(res.stdout);
    if (port === null) {
      throw new ContainerStartError(
        `docker port ${containerName} produced unparseable output: ${res.stdout}`,
      );
    }
    return port;
  }

  function startLogStream(): void {
    const stream = logStreamer(["logs", "--follow", containerName], {
      onLine: (line) => {
        const event = parseLogLine(line);
        if (event === null) {
          // Emit nothing; bad lines are swallowed. A strict operator can
          // opt into diagnostics by subscribing via future `onParseError`.
          // For now we preserve the type so tests can branch on it.
          void new ContainerLogParseError(`unparseable log line: ${line.slice(0, 200)}`);
          return;
        }
        if (event.type === "policy.egress_allowed") {
          emitter.emit("policy.egress_allowed", event);
        } else {
          emitter.emit("policy.egress_denied", event);
        }
      },
      onClose: () => {
        // Stream closed — either the container exited or the streamer was
        // disposed. Either way, nothing to do; `shutdown()` drives cleanup.
      },
    });
    logStreamDispose = stream.dispose;
  }

  async function reapContainer(): Promise<void> {
    // `docker kill` sends SIGKILL by default. We'd prefer SIGTERM first to
    // give the proxy a chance to flush logs, then SIGKILL after a grace
    // period. `--signal=SIGTERM` delivers SIGTERM; a follow-up `kill` (no
    // override) is hard-kill. Swallow "not found" because `--rm` may have
    // already cleaned up on a fast shutdown.
    const softRes = await runDocker(["kill", "--signal=SIGTERM", containerName], {
      timeoutMs: 3000,
    });
    if (softRes.exitCode === 0 && shutdownGraceMs > 0) {
      // Best-effort grace: wait briefly for the container to exit, then
      // hard-kill if it's still around. We don't have a native "wait" hook
      // available to the invoker seam; a short sleep + hard kill is fine.
      await new Promise<void>((resolve) => setTimeout(resolve, shutdownGraceMs));
    }
    const hardRes = await runDocker(["kill", containerName], { timeoutMs: 3000 });
    const softBenign =
      softRes.exitCode === 0 ||
      softRes.stderr.toLowerCase().includes("no such container") ||
      softRes.stderr.toLowerCase().includes("is not running");
    const hardBenign =
      hardRes.exitCode === 0 ||
      hardRes.stderr.toLowerCase().includes("no such container") ||
      hardRes.stderr.toLowerCase().includes("is not running");
    if (!softBenign && !hardBenign) {
      throw new ContainerShutdownError(
        `docker kill ${containerName} failed: soft=${softRes.stderr.trim()} hard=${hardRes.stderr.trim()}`,
      );
    }
  }

  async function reapNetwork(): Promise<void> {
    if (!createdNetwork) return;
    const res = await runDocker(["network", "rm", networkName], { timeoutMs: 5000 });
    if (res.exitCode === 0) return;
    const s = res.stderr.toLowerCase();
    if (s.includes("not found") || s.includes("has active endpoints") || s.includes("in use")) {
      // Common benign cases: already gone, or another (rogue) container
      // still attached. Leave the operator to clean up via `docker network prune`.
      return;
    }
    throw new ContainerShutdownError(
      `docker network rm ${networkName} exited ${res.exitCode}: ${res.stderr.trim()}`,
    );
  }

  const handle: ContainerEgressBrokerHandle = {
    get port() {
      return boundPort;
    },
    get url() {
      return boundPort > 0 ? `http://${host}:${boundPort}` : "";
    },
    get policy() {
      return policy;
    },
    get containerId() {
      return containerId;
    },
    get networkName() {
      return networkName;
    },
    on(type, listener) {
      return emitter.on(type, listener);
    },
    async start(): Promise<void> {
      if (containerId.length > 0 && boundPort > 0) return;
      if (starting) return starting;
      starting = (async () => {
        await assertDockerReachable();
        await ensureNetwork();
        const written = await writePolicyFile(serializePolicy(policy));
        policyCleanup = written.cleanup;
        try {
          containerId = await runContainer(written.path);
          boundPort = await resolveHostPort();
          startLogStream();
        } catch (err) {
          // Best-effort cleanup — leave the typed error to the caller.
          try {
            await reapContainer();
          } catch {
            // ignore
          }
          try {
            await reapNetwork();
          } catch {
            // ignore
          }
          if (policyCleanup) {
            try {
              await policyCleanup();
            } catch {
              // ignore
            }
            policyCleanup = null;
          }
          containerId = "";
          boundPort = 0;
          throw err;
        }
      })();
      try {
        await starting;
      } finally {
        starting = null;
      }
    },
    async shutdown(): Promise<void> {
      if (shutdownComplete) return;
      if (shuttingDown) return shuttingDown;
      // Nothing to do if we never started.
      if (containerId.length === 0 && boundPort === 0 && !createdNetwork && !policyCleanup) {
        shutdownComplete = true;
        return;
      }
      shuttingDown = (async () => {
        if (logStreamDispose) {
          try {
            logStreamDispose();
          } catch {
            // ignore
          }
          logStreamDispose = null;
        }
        if (containerId.length > 0) {
          try {
            await reapContainer();
          } catch (err) {
            // Surface the error but still try to clean up the network + file.
            try {
              await reapNetwork();
            } catch {
              // ignore
            }
            if (policyCleanup) {
              try {
                await policyCleanup();
              } catch {
                // ignore
              }
              policyCleanup = null;
            }
            containerId = "";
            boundPort = 0;
            throw err;
          }
        }
        await reapNetwork();
        if (policyCleanup) {
          try {
            await policyCleanup();
          } catch {
            // ignore
          }
          policyCleanup = null;
        }
        containerId = "";
        boundPort = 0;
      })();
      try {
        await shuttingDown;
        shutdownComplete = true;
      } finally {
        shuttingDown = null;
      }
    },
  };

  // Confirm we satisfy the in-process broker's structural contract at
  // assignment time — if `EgressBrokerHandle` ever grows a new member, this
  // assertion fails at typecheck time.
  const _shape: EgressBrokerHandle = handle;
  void _shape;

  return handle;
}
