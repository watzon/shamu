/**
 * Unit tests for `containerEgressPreflight`. Exercises each reason path
 * through the `DockerInvoker` seam.
 */

import { describe, expect, it } from "vitest";
import {
  containerEgressPreflight,
  DEFAULT_SIDECAR_IMAGE,
  type DockerInvoker,
} from "../src/index.ts";

function buildInvoker(
  responder: (args: readonly string[]) => {
    stdout: string;
    stderr: string;
    exitCode: number;
  },
): DockerInvoker {
  return async (args) => responder(args);
}

describe("containerEgressPreflight", () => {
  it("returns ok=true when docker, image, and no stale containers are present", async () => {
    const invoker = buildInvoker((args) => {
      if (args[0] === "version") return { stdout: "25.0.1\n", stderr: "", exitCode: 0 };
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: "[{}]\n", stderr: "", exitCode: 0 };
      }
      if (args[0] === "ps") return { stdout: "\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    });

    const result = await containerEgressPreflight({ dockerInvoker: invoker });
    expect(result.ok).toBe(true);
  });

  it("returns docker_unreachable when `docker version` exits non-zero", async () => {
    const invoker = buildInvoker((args) => {
      if (args[0] === "version") {
        return {
          stdout: "",
          stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
          exitCode: 1,
        };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    });

    const result = await containerEgressPreflight({ dockerInvoker: invoker });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("docker_unreachable");
    expect(result.detail).toContain("Cannot connect");
  });

  it("returns image_missing when neither inspect nor manifest finds the image", async () => {
    const invoker = buildInvoker((args) => {
      if (args[0] === "version") return { stdout: "25\n", stderr: "", exitCode: 0 };
      if (args[0] === "image" && args[1] === "inspect") {
        return {
          stdout: "",
          stderr: `Error: No such image: ${DEFAULT_SIDECAR_IMAGE}`,
          exitCode: 1,
        };
      }
      if (args[0] === "manifest" && args[1] === "inspect") {
        return {
          stdout: "",
          stderr: "no such manifest: shamu/egress-broker:0.1.0",
          exitCode: 1,
        };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    });

    const result = await containerEgressPreflight({ dockerInvoker: invoker });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("image_missing");
    expect(result.detail).toContain("not present locally");
  });

  it("returns ok=true when image is only resolvable via manifest (not local)", async () => {
    const invoker = buildInvoker((args) => {
      if (args[0] === "version") return { stdout: "25\n", stderr: "", exitCode: 0 };
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: "", stderr: "No such image", exitCode: 1 };
      }
      if (args[0] === "manifest" && args[1] === "inspect") {
        return { stdout: '{"schemaVersion":2}\n', stderr: "", exitCode: 0 };
      }
      if (args[0] === "ps") return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "unexpected", exitCode: 1 };
    });

    const result = await containerEgressPreflight({ dockerInvoker: invoker });
    expect(result.ok).toBe(true);
  });

  it("returns stale_containers when prior shamu-egress-* containers linger", async () => {
    const invoker = buildInvoker((args) => {
      if (args[0] === "version") return { stdout: "25\n", stderr: "", exitCode: 0 };
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: "[{}]", stderr: "", exitCode: 0 };
      }
      if (args[0] === "ps") {
        return {
          stdout: "shamu-egress-abc123\nshamu-egress-def456\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    });

    const result = await containerEgressPreflight({ dockerInvoker: invoker });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("stale_containers");
    expect(result.detail).toContain("shamu-egress-abc123");
    expect(result.detail).toContain("shamu-egress-def456");
  });

  it("returns network_error when `docker ps` itself fails", async () => {
    const invoker = buildInvoker((args) => {
      if (args[0] === "version") return { stdout: "25\n", stderr: "", exitCode: 0 };
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: "[{}]", stderr: "", exitCode: 0 };
      }
      if (args[0] === "ps") {
        return { stdout: "", stderr: "daemon restart midway", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    });

    const result = await containerEgressPreflight({ dockerInvoker: invoker });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("network_error");
    expect(result.detail).toContain("daemon restart midway");
  });
});
