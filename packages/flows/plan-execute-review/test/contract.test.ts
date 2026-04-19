/**
 * Contract tests -- assert the public module surface matches what 4.C's
 * loader expects. See the Track 4.B brief + the README surface section.
 */

import { RunnerRegistry } from "@shamu/core-flow/runners";
import { describe, expect, expectTypeOf, test } from "vitest";
import * as flowModule from "../src/index.ts";
import type { RegisterRunnersOptions } from "../src/runners.ts";

describe("module surface", () => {
  test("flowDefinition is exported", () => {
    expect(flowModule.flowDefinition).toBeDefined();
    expect(flowModule.flowDefinition.id).toBe("plan-execute-review");
  });

  test("registerRunners is a function", () => {
    expect(typeof flowModule.registerRunners).toBe("function");
  });

  test("name defaults to the flow id", () => {
    expect(flowModule.name).toBe(flowModule.flowDefinition.id);
  });

  test("parseOptions is exported and rejects unknown keys", () => {
    expect(typeof flowModule.parseOptions).toBe("function");
    expect(flowModule.parseOptions({})).toEqual({});
    expect(flowModule.parseOptions({ maxIterations: "3" }).maxIterations).toBe(3);
    expect(flowModule.parseOptions({ plannerModel: "x" }).plannerModel).toBe("x");
    expect(() => flowModule.parseOptions({ bogus: "y" })).toThrow(/unknown flow option/);
  });

  test("parseOptions rejects non-integer maxIterations", () => {
    expect(() => flowModule.parseOptions({ maxIterations: "abc" })).toThrow(/positive integer/);
    expect(() => flowModule.parseOptions({ maxIterations: "0" })).toThrow(/positive integer/);
  });

  test("registerRunners installs all five runners on the registry", () => {
    const registry = new RunnerRegistry();
    flowModule.registerRunners(registry, {
      workspaceCwd: "/tmp/shamu-contract",
    });
    expect(registry.has("planner")).toBe(true);
    expect(registry.has("executor")).toBe(true);
    expect(registry.has("ci")).toBe(true);
    expect(registry.has("reviewer")).toBe(true);
    expect(registry.has("loop-predicate")).toBe(true);
  });

  test("registerRunners rejects empty workspaceCwd", () => {
    const registry = new RunnerRegistry();
    expect(() => flowModule.registerRunners(registry, { workspaceCwd: "" })).toThrow(
      /workspaceCwd/,
    );
  });

  test("registerRunners rejects non-positive maxIterations", () => {
    const registry = new RunnerRegistry();
    expect(() =>
      flowModule.registerRunners(registry, { workspaceCwd: "/tmp/x", maxIterations: 0 }),
    ).toThrow(/maxIterations/);
  });

  test("RegisterRunnersOptions has the expected fields (type-level)", () => {
    type ExpectedKeys =
      | "anthropicCliPath"
      | "codexCliPath"
      | "workspaceCwd"
      | "maxIterations"
      | "plannerModel"
      | "executorModel"
      | "reviewerModel"
      | "ci"
      | "spawnEnv"
      | "__adapterOverride"
      | "__ciRunOverride";
    // All real option keys (sans the __-prefixed test seams) must map into
    // the known set.
    expectTypeOf<keyof RegisterRunnersOptions>().toExtend<ExpectedKeys>();
    expectTypeOf<RegisterRunnersOptions["workspaceCwd"]>().toEqualTypeOf<string>();
    expectTypeOf<NonNullable<RegisterRunnersOptions["maxIterations"]>>().toEqualTypeOf<number>();
  });
});
