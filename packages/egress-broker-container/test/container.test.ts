/**
 * Unit tests for `createContainerEgressBroker`. All Docker interactions go
 * through the `DockerInvoker` + `DockerLogStreamer` test seams — no live
 * Docker daemon is required (and none is used).
 */

import { type EgressPolicy, policyFromAllowlist } from "@shamu/egress-broker";
import { describe, expect, it } from "vitest";
import {
  ContainerStartError,
  createContainerEgressBroker,
  type DockerInvoker,
  type DockerLogStreamer,
  DockerUnreachableError,
} from "../src/index.ts";

type InvokerCall = { args: readonly string[]; input?: string; timeoutMs?: number };

/**
 * Build a scripted `DockerInvoker`. Each call matches the first step in
 * `script` whose predicate returns true; we pop that step off and return
 * its result. If nothing matches, we throw — that's a test-writer bug.
 */
function scriptedInvoker(
  script: Array<{
    match: (args: readonly string[]) => boolean;
    result: { stdout: string; stderr: string; exitCode: number };
  }>,
): { invoker: DockerInvoker; calls: InvokerCall[] } {
  const calls: InvokerCall[] = [];
  const remaining = script.slice();
  const invoker: DockerInvoker = async (args, options) => {
    calls.push({
      args,
      ...(options?.input !== undefined ? { input: options.input } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    const idx = remaining.findIndex((step) => step.match(args));
    if (idx < 0) {
      throw new Error(`unexpected docker invocation: ${args.join(" ")}`);
    }
    const step = remaining[idx];
    if (!step) throw new Error("invariant: matched step vanished");
    remaining.splice(idx, 1);
    return step.result;
  };
  return { invoker, calls };
}

/** Build a log streamer that we can push lines through on demand. */
function controllableLogStreamer(): {
  streamer: DockerLogStreamer;
  push: (line: string) => void;
  close: (code?: number) => void;
  disposed: () => boolean;
} {
  let onLine: ((line: string) => void) | null = null;
  let onClose: ((code: number) => void) | null = null;
  let disposed = false;
  const streamer: DockerLogStreamer = (_args, handlers) => {
    onLine = handlers.onLine;
    onClose = handlers.onClose;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        onClose?.(0);
      },
    };
  };
  return {
    streamer,
    push: (line) => {
      onLine?.(line);
    },
    close: (code = 0) => {
      onClose?.(code);
    },
    disposed: () => disposed,
  };
}

/** Minimal policy. */
function testPolicy(): EgressPolicy {
  return policyFromAllowlist(["api.anthropic.com"]);
}

/** Default writer — returns a stable path so assertions are deterministic. */
function deterministicPolicyWriter(path = "/tmp/shamu-policy-TEST.json"): {
  writePolicyFile: (json: string) => Promise<{ path: string; cleanup: () => Promise<void> }>;
  cleanupCalls: () => number;
  lastJson: () => string | null;
} {
  let cleanups = 0;
  let last: string | null = null;
  const writePolicyFile = async (json: string) => {
    last = json;
    return {
      path,
      cleanup: async () => {
        cleanups += 1;
      },
    };
  };
  return {
    writePolicyFile,
    cleanupCalls: () => cleanups,
    lastJson: () => last,
  };
}

describe("createContainerEgressBroker — start() lifecycle", () => {
  it("asserts docker reachable, creates network, runs container, resolves host port", async () => {
    const { invoker, calls } = scriptedInvoker([
      {
        match: (a) => a[0] === "version",
        result: { stdout: "25.0.1\n", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "network" && a[1] === "create",
        result: { stdout: "net-id\n", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "run",
        result: { stdout: "container-abc\n", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "port",
        result: { stdout: "0.0.0.0:32768\n", stderr: "", exitCode: 0 },
      },
      // Shutdown path.
      {
        match: (a) => a[0] === "kill" && a[1] === "--signal=SIGTERM",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "kill" && a[1] !== "--signal=SIGTERM",
        result: { stdout: "", stderr: "is not running", exitCode: 1 },
      },
      {
        match: (a) => a[0] === "network" && a[1] === "rm",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
    ]);
    const logs = controllableLogStreamer();
    const writer = deterministicPolicyWriter();

    const broker = createContainerEgressBroker({
      policy: testPolicy(),
      networkName: "shamu-egress-net-TEST",
      uuid: () => "TEST",
      dockerInvoker: invoker,
      dockerLogStreamer: logs.streamer,
      writePolicyFile: writer.writePolicyFile,
      shutdownGraceMs: 0,
    });

    await broker.start();

    expect(broker.containerId).toBe("container-abc");
    expect(broker.port).toBe(32768);
    expect(broker.url).toBe("http://127.0.0.1:32768");
    expect(broker.networkName).toBe("shamu-egress-net-TEST");
    expect(broker.policy).toEqual(testPolicy());

    // Verify the exact shape of the `docker run` invocation.
    const runCall = calls.find((c) => c.args[0] === "run");
    expect(runCall).toBeDefined();
    if (!runCall) throw new Error("unreachable");
    const runArgs = runCall.args;
    expect(runArgs).toContain("-d");
    expect(runArgs).toContain("--rm");
    expect(runArgs).toContain("--name");
    // Container name is `shamu-egress-<uuid>`. uuid="TEST".
    const nameIdx = runArgs.indexOf("--name");
    expect(runArgs[nameIdx + 1]).toBe("shamu-egress-TEST");
    const netIdx = runArgs.indexOf("--network");
    expect(runArgs[netIdx + 1]).toBe("shamu-egress-net-TEST");
    const portIdx = runArgs.indexOf("-p");
    expect(runArgs[portIdx + 1]).toBe("127.0.0.1:0:8080");
    const volIdx = runArgs.indexOf("-v");
    expect(runArgs[volIdx + 1]).toBe("/tmp/shamu-policy-TEST.json:/etc/shamu/policy.json:ro");
    // Image last.
    expect(runArgs[runArgs.length - 1]).toMatch(/^shamu\/egress-broker:/);

    // Verify the serialized policy was produced correctly.
    const json = writer.lastJson();
    expect(json).toBeTruthy();
    if (!json) throw new Error("unreachable");
    const parsed = JSON.parse(json);
    expect(parsed.defaultPolicy).toBe("deny");
    expect(parsed.allowedHosts).toContain("api.anthropic.com");

    await broker.shutdown();
  });

  it("start() is idempotent (second call is a no-op)", async () => {
    const { invoker } = scriptedInvoker([
      { match: (a) => a[0] === "version", result: { stdout: "25\n", stderr: "", exitCode: 0 } },
      {
        match: (a) => a[0] === "network" && a[1] === "create",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      { match: (a) => a[0] === "run", result: { stdout: "c1\n", stderr: "", exitCode: 0 } },
      {
        match: (a) => a[0] === "port",
        result: { stdout: "127.0.0.1:9999\n", stderr: "", exitCode: 0 },
      },
      // No second `run` / `port` entries — if start() wasn't idempotent the
      // scripted invoker would throw.
      {
        match: (a) => a[0] === "kill" && a[1] === "--signal=SIGTERM",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "kill" && a[1] !== "--signal=SIGTERM",
        result: { stdout: "", stderr: "is not running", exitCode: 1 },
      },
      {
        match: (a) => a[0] === "network" && a[1] === "rm",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
    ]);
    const logs = controllableLogStreamer();
    const writer = deterministicPolicyWriter();

    const broker = createContainerEgressBroker({
      policy: testPolicy(),
      uuid: () => "A",
      dockerInvoker: invoker,
      dockerLogStreamer: logs.streamer,
      writePolicyFile: writer.writePolicyFile,
      shutdownGraceMs: 0,
    });

    await broker.start();
    await broker.start();
    expect(broker.containerId).toBe("c1");
    expect(broker.port).toBe(9999);

    await broker.shutdown();
  });

  it("swallows 'network already exists' on the create call", async () => {
    const { invoker } = scriptedInvoker([
      { match: (a) => a[0] === "version", result: { stdout: "25\n", stderr: "", exitCode: 0 } },
      {
        match: (a) => a[0] === "network" && a[1] === "create",
        result: {
          stdout: "",
          stderr: "Error response from daemon: network with name already exists",
          exitCode: 1,
        },
      },
      { match: (a) => a[0] === "run", result: { stdout: "c1\n", stderr: "", exitCode: 0 } },
      {
        match: (a) => a[0] === "port",
        result: { stdout: "0.0.0.0:8000\n", stderr: "", exitCode: 0 },
      },
      // Shutdown — we did NOT create the network so no `network rm` is expected.
      {
        match: (a) => a[0] === "kill" && a[1] === "--signal=SIGTERM",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "kill" && a[1] !== "--signal=SIGTERM",
        result: { stdout: "", stderr: "is not running", exitCode: 1 },
      },
    ]);
    const logs = controllableLogStreamer();
    const writer = deterministicPolicyWriter();

    const broker = createContainerEgressBroker({
      policy: testPolicy(),
      networkName: "preexisting-net",
      uuid: () => "B",
      dockerInvoker: invoker,
      dockerLogStreamer: logs.streamer,
      writePolicyFile: writer.writePolicyFile,
      shutdownGraceMs: 0,
    });

    await expect(broker.start()).resolves.toBeUndefined();
    await broker.shutdown();
  });
});

describe("createContainerEgressBroker — error paths", () => {
  it("throws DockerUnreachableError when `docker version` exits non-zero", async () => {
    const { invoker } = scriptedInvoker([
      {
        match: (a) => a[0] === "version",
        result: {
          stdout: "",
          stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
          exitCode: 1,
        },
      },
    ]);
    const logs = controllableLogStreamer();
    const writer = deterministicPolicyWriter();

    const broker = createContainerEgressBroker({
      policy: testPolicy(),
      uuid: () => "X",
      dockerInvoker: invoker,
      dockerLogStreamer: logs.streamer,
      writePolicyFile: writer.writePolicyFile,
      shutdownGraceMs: 0,
    });

    await expect(broker.start()).rejects.toBeInstanceOf(DockerUnreachableError);
  });

  it("throws ContainerStartError when `docker run` fails (e.g. image missing)", async () => {
    const { invoker } = scriptedInvoker([
      { match: (a) => a[0] === "version", result: { stdout: "25\n", stderr: "", exitCode: 0 } },
      {
        match: (a) => a[0] === "network" && a[1] === "create",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "run",
        result: {
          stdout: "",
          stderr: "Unable to find image 'shamu/egress-broker:0.1.0' locally",
          exitCode: 125,
        },
      },
      // Cleanup path: soft + hard kill are attempted.
      {
        match: (a) => a[0] === "kill" && a[1] === "--signal=SIGTERM",
        result: { stdout: "", stderr: "No such container", exitCode: 1 },
      },
      {
        match: (a) => a[0] === "kill" && a[1] !== "--signal=SIGTERM",
        result: { stdout: "", stderr: "No such container", exitCode: 1 },
      },
      {
        match: (a) => a[0] === "network" && a[1] === "rm",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
    ]);
    const logs = controllableLogStreamer();
    const writer = deterministicPolicyWriter();

    const broker = createContainerEgressBroker({
      policy: testPolicy(),
      uuid: () => "Y",
      dockerInvoker: invoker,
      dockerLogStreamer: logs.streamer,
      writePolicyFile: writer.writePolicyFile,
      shutdownGraceMs: 0,
    });

    await expect(broker.start()).rejects.toBeInstanceOf(ContainerStartError);
    expect(writer.cleanupCalls()).toBeGreaterThanOrEqual(1);
  });

  it("throws ContainerStartError when `docker port` yields unparseable output", async () => {
    const { invoker } = scriptedInvoker([
      { match: (a) => a[0] === "version", result: { stdout: "25\n", stderr: "", exitCode: 0 } },
      {
        match: (a) => a[0] === "network" && a[1] === "create",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      { match: (a) => a[0] === "run", result: { stdout: "c1\n", stderr: "", exitCode: 0 } },
      {
        match: (a) => a[0] === "port",
        result: { stdout: "garbage-no-colon\n", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "kill" && a[1] === "--signal=SIGTERM",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "kill" && a[1] !== "--signal=SIGTERM",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "network" && a[1] === "rm",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
    ]);
    const logs = controllableLogStreamer();
    const writer = deterministicPolicyWriter();

    const broker = createContainerEgressBroker({
      policy: testPolicy(),
      uuid: () => "Z",
      dockerInvoker: invoker,
      dockerLogStreamer: logs.streamer,
      writePolicyFile: writer.writePolicyFile,
      shutdownGraceMs: 0,
    });

    await expect(broker.start()).rejects.toBeInstanceOf(ContainerStartError);
  });
});

describe("createContainerEgressBroker — log stream → event emission", () => {
  it("parses NDJSON lines into policy.egress_allowed / denied events", async () => {
    const { invoker } = scriptedInvoker([
      { match: (a) => a[0] === "version", result: { stdout: "25\n", stderr: "", exitCode: 0 } },
      {
        match: (a) => a[0] === "network" && a[1] === "create",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      { match: (a) => a[0] === "run", result: { stdout: "c1\n", stderr: "", exitCode: 0 } },
      {
        match: (a) => a[0] === "port",
        result: { stdout: "127.0.0.1:1234\n", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "kill" && a[1] === "--signal=SIGTERM",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "kill" && a[1] !== "--signal=SIGTERM",
        result: { stdout: "", stderr: "is not running", exitCode: 1 },
      },
      {
        match: (a) => a[0] === "network" && a[1] === "rm",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
    ]);
    const logs = controllableLogStreamer();
    const writer = deterministicPolicyWriter();

    const broker = createContainerEgressBroker({
      policy: testPolicy(),
      uuid: () => "L",
      dockerInvoker: invoker,
      dockerLogStreamer: logs.streamer,
      writePolicyFile: writer.writePolicyFile,
      shutdownGraceMs: 0,
    });

    const allowed: Array<{ host: string; proxyMethod: string }> = [];
    const denied: Array<{ host: string; reason: string }> = [];
    broker.on("policy.egress_allowed", (ev) =>
      allowed.push({ host: ev.host, proxyMethod: ev.proxyMethod }),
    );
    broker.on("policy.egress_denied", (ev) => denied.push({ host: ev.host, reason: ev.reason }));

    await broker.start();

    // Push a few valid lines + garbage. The broker should silently ignore
    // garbage and only emit for well-formed events.
    logs.push(
      JSON.stringify({
        type: "policy.egress_allowed",
        ts: 1_700_000_000_000,
        proxyMethod: "CONNECT",
        host: "api.anthropic.com",
        port: 443,
        clientAddr: "172.17.0.3:40000",
      }),
    );
    logs.push("not-a-json-line");
    logs.push(
      JSON.stringify({
        type: "policy.egress_denied",
        ts: 1_700_000_000_001,
        proxyMethod: "HTTP",
        rawTarget: "http://attacker.example/",
        host: "attacker.example",
        port: 80,
        reason: "host_not_allowlisted",
      }),
    );
    // Missing required fields — silently dropped.
    logs.push(JSON.stringify({ type: "policy.egress_allowed", host: "x" }));
    // Unknown type — silently dropped.
    logs.push(JSON.stringify({ type: "policy.something_else", ts: 1 }));

    expect(allowed).toEqual([{ host: "api.anthropic.com", proxyMethod: "CONNECT" }]);
    expect(denied).toEqual([{ host: "attacker.example", reason: "host_not_allowlisted" }]);

    await broker.shutdown();
  });

  it("on() returns an unsubscribe that stops further events", async () => {
    const { invoker } = scriptedInvoker([
      { match: (a) => a[0] === "version", result: { stdout: "25\n", stderr: "", exitCode: 0 } },
      {
        match: (a) => a[0] === "network" && a[1] === "create",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      { match: (a) => a[0] === "run", result: { stdout: "c1\n", stderr: "", exitCode: 0 } },
      {
        match: (a) => a[0] === "port",
        result: { stdout: "127.0.0.1:1\n", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "kill" && a[1] === "--signal=SIGTERM",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
      {
        match: (a) => a[0] === "kill" && a[1] !== "--signal=SIGTERM",
        result: { stdout: "", stderr: "is not running", exitCode: 1 },
      },
      {
        match: (a) => a[0] === "network" && a[1] === "rm",
        result: { stdout: "", stderr: "", exitCode: 0 },
      },
    ]);
    const logs = controllableLogStreamer();
    const writer = deterministicPolicyWriter();

    const broker = createContainerEgressBroker({
      policy: testPolicy(),
      uuid: () => "U",
      dockerInvoker: invoker,
      dockerLogStreamer: logs.streamer,
      writePolicyFile: writer.writePolicyFile,
      shutdownGraceMs: 0,
    });

    await broker.start();
    let hits = 0;
    const off = broker.on("policy.egress_allowed", () => {
      hits += 1;
    });
    const line = JSON.stringify({
      type: "policy.egress_allowed",
      ts: 1,
      proxyMethod: "CONNECT",
      host: "h",
      port: 443,
    });
    logs.push(line);
    expect(hits).toBe(1);
    off();
    logs.push(line);
    expect(hits).toBe(1);

    await broker.shutdown();
  });
});

describe("createContainerEgressBroker — shutdown() behaviour", () => {
  it("is idempotent: two sequential calls perform exactly one reap", async () => {
    let killSoftCount = 0;
    let killHardCount = 0;
    let netRmCount = 0;
    const invoker: DockerInvoker = async (args) => {
      if (args[0] === "version") return { stdout: "25\n", stderr: "", exitCode: 0 };
      if (args[0] === "network" && args[1] === "create") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "run") return { stdout: "c1\n", stderr: "", exitCode: 0 };
      if (args[0] === "port") return { stdout: "127.0.0.1:55555\n", stderr: "", exitCode: 0 };
      if (args[0] === "kill" && args[1] === "--signal=SIGTERM") {
        killSoftCount += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "kill") {
        killHardCount += 1;
        return { stdout: "", stderr: "is not running", exitCode: 1 };
      }
      if (args[0] === "network" && args[1] === "rm") {
        netRmCount += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const logs = controllableLogStreamer();
    const writer = deterministicPolicyWriter();

    const broker = createContainerEgressBroker({
      policy: testPolicy(),
      uuid: () => "D",
      dockerInvoker: invoker,
      dockerLogStreamer: logs.streamer,
      writePolicyFile: writer.writePolicyFile,
      shutdownGraceMs: 0,
    });

    await broker.start();
    await broker.shutdown();
    await broker.shutdown();

    expect(killSoftCount).toBe(1);
    // Hard kill is attempted exactly once after the soft-kill grace period.
    expect(killHardCount).toBe(1);
    expect(netRmCount).toBe(1);
    expect(logs.disposed()).toBe(true);
    expect(writer.cleanupCalls()).toBe(1);
    expect(broker.containerId).toBe("");
    expect(broker.port).toBe(0);
  });

  it("shutdown() is safe to call before start()", async () => {
    const invoker: DockerInvoker = async () => {
      throw new Error("docker should not be invoked on pre-start shutdown");
    };
    const logs = controllableLogStreamer();
    const writer = deterministicPolicyWriter();

    const broker = createContainerEgressBroker({
      policy: testPolicy(),
      uuid: () => "P",
      dockerInvoker: invoker,
      dockerLogStreamer: logs.streamer,
      writePolicyFile: writer.writePolicyFile,
      shutdownGraceMs: 0,
    });

    await expect(broker.shutdown()).resolves.toBeUndefined();
  });

  it("does NOT remove a network it didn't create", async () => {
    let netRmCount = 0;
    const invoker: DockerInvoker = async (args) => {
      if (args[0] === "version") return { stdout: "25\n", stderr: "", exitCode: 0 };
      if (args[0] === "network" && args[1] === "create") {
        return {
          stdout: "",
          stderr: "network with name preexisting already exists",
          exitCode: 1,
        };
      }
      if (args[0] === "run") return { stdout: "c1\n", stderr: "", exitCode: 0 };
      if (args[0] === "port") return { stdout: "127.0.0.1:1\n", stderr: "", exitCode: 0 };
      if (args[0] === "kill") {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (args[0] === "network" && args[1] === "rm") {
        netRmCount += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    };
    const logs = controllableLogStreamer();
    const writer = deterministicPolicyWriter();

    const broker = createContainerEgressBroker({
      policy: testPolicy(),
      networkName: "preexisting",
      uuid: () => "N",
      dockerInvoker: invoker,
      dockerLogStreamer: logs.streamer,
      writePolicyFile: writer.writePolicyFile,
      shutdownGraceMs: 0,
    });

    await broker.start();
    await broker.shutdown();

    // We never created the network, so we don't remove it.
    expect(netRmCount).toBe(0);
  });
});
