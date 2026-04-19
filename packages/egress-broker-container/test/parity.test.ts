/**
 * Structural parity between `ContainerEgressBrokerHandle` and
 * `EgressBrokerHandle`.
 *
 * Goal: guarantee that any caller wired to `EgressBrokerHandle` can accept a
 * `ContainerEgressBrokerHandle` without change. We enforce this at both
 * type-level (a variable assignment) and runtime (key-shape reflection).
 */

import {
  createEgressBroker,
  type EgressBrokerHandle,
  policyFromAllowlist,
} from "@shamu/egress-broker";
import { describe, expect, it } from "vitest";
import {
  type ContainerEgressBrokerHandle,
  createContainerEgressBroker,
  type DockerInvoker,
  type DockerLogStreamer,
} from "../src/index.ts";

describe("EgressBrokerHandle parity", () => {
  it("ContainerEgressBrokerHandle is assignable to EgressBrokerHandle at the type level", () => {
    // Build both with real policies but using the test seams so nothing
    // actually starts. The *assignment* below is the load-bearing check —
    // if the container handle ever drops a member, this fails at `tsc`.
    const policy = policyFromAllowlist(["api.anthropic.com"]);
    const noopInvoker: DockerInvoker = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    const noopStreamer: DockerLogStreamer = () => ({ dispose: () => {} });
    const writePolicyFile = async () => ({ path: "/tmp/x", cleanup: async () => {} });

    const inProcess: EgressBrokerHandle = createEgressBroker({ policy });
    const container: ContainerEgressBrokerHandle = createContainerEgressBroker({
      policy,
      dockerInvoker: noopInvoker,
      dockerLogStreamer: noopStreamer,
      writePolicyFile,
    });
    // The load-bearing assignment: if the container handle stops matching
    // the base handle's shape, `tsc --noEmit` fails this test file.
    const asBase: EgressBrokerHandle = container;
    expect(typeof asBase).toBe("object");
    expect(typeof inProcess).toBe("object");
  });

  it("runtime-reflected keys match for the EgressBrokerHandle surface", () => {
    const policy = policyFromAllowlist(["api.anthropic.com"]);
    const noopInvoker: DockerInvoker = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    const noopStreamer: DockerLogStreamer = () => ({ dispose: () => {} });
    const writePolicyFile = async () => ({ path: "/tmp/x", cleanup: async () => {} });

    const inProcess = createEgressBroker({ policy });
    const container = createContainerEgressBroker({
      policy,
      dockerInvoker: noopInvoker,
      dockerLogStreamer: noopStreamer,
      writePolicyFile,
    });

    // The base surface we rely on:
    const REQUIRED: Array<{ key: keyof EgressBrokerHandle; kind: "fn" | "val" }> = [
      { key: "start", kind: "fn" },
      { key: "shutdown", kind: "fn" },
      { key: "on", kind: "fn" },
      { key: "port", kind: "val" },
      { key: "url", kind: "val" },
      { key: "policy", kind: "val" },
    ];

    for (const { key, kind } of REQUIRED) {
      const inProcVal = (inProcess as unknown as Record<string, unknown>)[key];
      const containerVal = (container as unknown as Record<string, unknown>)[key];
      if (kind === "fn") {
        expect(typeof inProcVal).toBe("function");
        expect(typeof containerVal).toBe("function");
      } else {
        // Value-typed accessors ('port', 'url', 'policy'): primitive, string,
        // or object — but the type should be the same across both handles
        // pre-start.
        expect(typeof inProcVal).toBe(typeof containerVal);
      }
    }

    // Container-specific extensions exist and are strings.
    expect(typeof container.containerId).toBe("string");
    expect(typeof container.networkName).toBe("string");
  });

  it("policy passed to createContainerEgressBroker is exposed verbatim", () => {
    const policy = policyFromAllowlist(["api.anthropic.com"], [".fireworks.ai"]);
    const noopInvoker: DockerInvoker = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    const noopStreamer: DockerLogStreamer = () => ({ dispose: () => {} });
    const writePolicyFile = async () => ({ path: "/tmp/x", cleanup: async () => {} });

    const broker = createContainerEgressBroker({
      policy,
      dockerInvoker: noopInvoker,
      dockerLogStreamer: noopStreamer,
      writePolicyFile,
    });

    expect(broker.policy).toBe(policy);
    // Pre-start invariants.
    expect(broker.port).toBe(0);
    expect(broker.url).toBe("");
    expect(broker.containerId).toBe("");
  });
});
