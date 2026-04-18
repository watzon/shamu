/**
 * Unit tests for `createRunIssueRegistry`.
 */

import { runId as brandRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { createRunIssueRegistry } from "../registry.ts";

const R1 = brandRunId("run-1");
const R2 = brandRunId("run-2");

describe("createRunIssueRegistry", () => {
  it("binds a pair and supports bidirectional lookup", () => {
    const reg = createRunIssueRegistry();
    reg.bind(R1, "issue-1");
    expect(reg.runIdFor("issue-1")).toBe(R1);
    expect(reg.issueIdFor(R1)).toBe("issue-1");
    expect(reg.size()).toBe(1);
  });

  it("double-bind with the same pair is a no-op", () => {
    const reg = createRunIssueRegistry();
    reg.bind(R1, "issue-1");
    // No throw, size unchanged.
    reg.bind(R1, "issue-1");
    expect(reg.size()).toBe(1);
  });

  it("double-bind with conflicting issue throws TypeError", () => {
    const reg = createRunIssueRegistry();
    reg.bind(R1, "issue-1");
    expect(() => reg.bind(R1, "issue-2")).toThrow(TypeError);
    // Original binding preserved.
    expect(reg.issueIdFor(R1)).toBe("issue-1");
  });

  it("release removes both sides of the binding", () => {
    const reg = createRunIssueRegistry();
    reg.bind(R1, "issue-1");
    reg.release(R1);
    expect(reg.runIdFor("issue-1")).toBeNull();
    expect(reg.issueIdFor(R1)).toBeNull();
    expect(reg.size()).toBe(0);
  });

  it("release on an unknown runId is a silent no-op", () => {
    const reg = createRunIssueRegistry();
    // No throw, size still 0.
    reg.release(R1);
    expect(reg.size()).toBe(0);
  });

  it("clear drops every binding", () => {
    const reg = createRunIssueRegistry();
    reg.bind(R1, "issue-1");
    reg.bind(R2, "issue-2");
    expect(reg.size()).toBe(2);
    reg.clear();
    expect(reg.size()).toBe(0);
    expect(reg.runIdFor("issue-1")).toBeNull();
    expect(reg.issueIdFor(R2)).toBeNull();
  });

  it("lookup misses return null (not undefined)", () => {
    const reg = createRunIssueRegistry();
    expect(reg.runIdFor("does-not-exist")).toBeNull();
    expect(reg.issueIdFor(R1)).toBeNull();
  });
});
