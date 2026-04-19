/**
 * Public types for `@shamu/egress-broker-container`.
 *
 * The container-backed broker is a drop-in peer of the in-process broker in
 * `@shamu/egress-broker`. It exposes the same `EgressBrokerHandle` surface so
 * callers can swap backends at the factory boundary. The key difference is
 * *isolation*: the in-process broker relies on the subprocess honouring
 * `HTTPS_PROXY`/`HTTP_PROXY`, while the container broker puts the proxy
 * inside its own network namespace — the adapter subprocess has no route to
 * the outside world except via the broker.
 *
 * See PLAN.md § "Phase 8 → Track 8.C" ("Container-based network egress
 * enforcement"). Re-exports from `@shamu/egress-broker` keep the policy +
 * event shape a single source of truth.
 */

import type {
  EgressBrokerHandle,
  EgressBrokerOptions,
  PolicyEgressAllowedEvent,
  PolicyEgressDeniedEvent,
} from "@shamu/egress-broker";
import { ShamuError } from "@shamu/shared/errors";

/**
 * Default Docker image tag the broker launches. Overridable via
 * `ContainerEgressBrokerOptions.image`. The release pipeline (out of scope
 * for this PR) publishes images under this tag pattern; for local dev,
 * build via `docker/README.md`.
 */
export const SIDECAR_IMAGE_VERSION = "0.1.0" as const;
export const DEFAULT_SIDECAR_IMAGE = `shamu/egress-broker:${SIDECAR_IMAGE_VERSION}` as const;

/**
 * Default container-internal port the sidecar proxy listens on. We publish
 * this port to an OS-assigned host port at run time.
 */
export const DEFAULT_CONTAINER_PROXY_PORT = 8080 as const;

/**
 * Default path inside the container where the proxy reads its policy. The
 * host mounts a per-run JSON file read-only at this path.
 */
export const DEFAULT_CONTAINER_POLICY_PATH = "/etc/shamu/policy.json" as const;

/**
 * Test seam so unit tests can exercise the full lifecycle without a live
 * Docker daemon. In production this is `spawn(dockerPath, args)` piped
 * through a small `collect stdout/stderr until exit` helper.
 *
 * `input` (optional) is written to stdin before stdin is closed. `timeoutMs`
 * caps the call; the invoker is expected to kill the process on timeout and
 * surface that as `{ exitCode: <non-zero>, stderr: "timeout" }` — we treat
 * any non-zero exit as an error by inspecting the result in-band.
 */
export type DockerInvoker = (
  args: readonly string[],
  options?: { input?: string; timeoutMs?: number },
) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/**
 * Streaming seam for `docker logs --follow`. Emits each NDJSON line as the
 * container writes it. Returns a dispose thunk that terminates the follow
 * (the invoker is expected to SIGTERM the `docker logs` subprocess and
 * resolve `onClose` once it exits).
 */
export type DockerLogStreamer = (
  args: readonly string[],
  handlers: {
    readonly onLine: (line: string) => void;
    readonly onClose: (exitCode: number) => void;
  },
) => { readonly dispose: () => void };

export interface ContainerEgressBrokerOptions extends EgressBrokerOptions {
  /**
   * Docker image tag to run. Defaults to `DEFAULT_SIDECAR_IMAGE`.
   */
  readonly image?: string;
  /**
   * `docker` binary path. Default: `"docker"` (resolved via `PATH`).
   */
  readonly dockerPath?: string;
  /**
   * Network name the container attaches to. Default: a per-broker random
   * name (`shamu-egress-net-<uuid>`) so parallel runs can coexist without a
   * global network race.
   */
  readonly networkName?: string;
  /**
   * Test seam: substitute the `DockerInvoker` with a fake. Production uses
   * an internal `spawn(dockerPath, args)` helper.
   */
  readonly dockerInvoker?: DockerInvoker;
  /**
   * Test seam: substitute the `docker logs --follow` streamer. Production
   * uses an internal `spawn` wrapper that emits NDJSON lines.
   */
  readonly dockerLogStreamer?: DockerLogStreamer;
  /**
   * Test seam: deterministic id minter. Defaults to `crypto.randomUUID()`.
   */
  readonly uuid?: () => string;
  /**
   * Test seam: alternate temp-file writer. Receives the serialized policy
   * JSON and returns a host path that the container will bind-mount at
   * `DEFAULT_CONTAINER_POLICY_PATH`. Defaults to a `os.tmpdir()` writer.
   * The cleanup thunk runs on `shutdown()`.
   */
  readonly writePolicyFile?: (
    policyJson: string,
  ) => Promise<{ readonly path: string; readonly cleanup: () => Promise<void> }>;
  /**
   * Milliseconds to wait between a graceful `docker kill --signal=SIGTERM`
   * and the follow-up hard kill. Default `500`. Tests set this to `0` to
   * keep the suite fast; production should stay near the default so the
   * in-container proxy has time to flush its final NDJSON lines before
   * Docker tears down stdout.
   */
  readonly shutdownGraceMs?: number;
}

/**
 * Handle returned from `createContainerEgressBroker`. Extends
 * `EgressBrokerHandle` with container-specific observability: the caller can
 * `docker inspect <containerId>` for debugging, and `networkName` tells
 * operators which network to tear down manually if the broker crashes.
 */
export interface ContainerEgressBrokerHandle extends EgressBrokerHandle {
  /** Container id assigned by Docker. Empty string until `start()` resolves. */
  readonly containerId: string;
  /** Network name the container is attached to. */
  readonly networkName: string;
}

/**
 * The broker failed to reach the Docker daemon. Thrown on `start()` when
 * `docker version` returns non-zero. Detail includes the stderr snippet so
 * `shamu doctor` can show the operator what Docker said.
 */
export class DockerUnreachableError extends ShamuError {
  public readonly code = "docker_unreachable" as const;
}

/**
 * The broker reached Docker but failed to start the container (image
 * missing, network error, port allocation failure, etc.).
 */
export class ContainerStartError extends ShamuError {
  public readonly code = "container_start_error" as const;
}

/**
 * The broker failed during `shutdown()` and could not cleanly reap the
 * container or network. Callers typically log + continue — a leaked
 * container is visible to `shamu doctor` via the preflight check.
 */
export class ContainerShutdownError extends ShamuError {
  public readonly code = "container_shutdown_error" as const;
}

/**
 * NDJSON log line from the container was unparseable. Thrown only on the
 * background task and surfaced to operators via the broker's event stream
 * as a diagnostic. We never let a parse failure take down the broker.
 */
export class ContainerLogParseError extends ShamuError {
  public readonly code = "container_log_parse_error" as const;
}

/**
 * Preflight result surfaced by `containerEgressPreflight()`.
 *
 * - `{ ok: true }` — Docker reachable, image present or resolvable via
 *   registry, no stale `shamu-egress-*` containers from prior crashes.
 * - `{ ok: false, reason, detail }` — operator-facing diagnostic; the
 *   `reason` is a stable enum so `shamu doctor` can map to actionable copy.
 */
export type ContainerEgressPreflightResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | "docker_unreachable"
        | "image_missing"
        | "stale_containers"
        | "network_error";
      readonly detail: string;
    };

/** Re-export the shared event shapes so consumers don't need a second import. */
export type { PolicyEgressAllowedEvent, PolicyEgressDeniedEvent };
