/**
 * Unit tests for `attachPrToIssue`.
 *
 * Thin wrapper over `LinearClient.createAttachment`; the tests assert it
 * passes inputs through and surfaces errors unchanged.
 */

import type {
  Attachment,
  LinearClient,
  LinearError as RealLinearError,
} from "@shamu/linear-client";
import { LinearError } from "@shamu/linear-client";
import { err, ok, type Result } from "@shamu/shared/result";
import { describe, expect, it } from "vitest";
import { attachPrToIssue } from "../attachments.ts";

interface RecordedCreate {
  readonly issueId: string;
  readonly url: string;
  readonly title: string;
  readonly subtitle?: string;
}

function makeFakeClient(result: Result<Attachment, RealLinearError>): {
  client: LinearClient;
  calls: RecordedCreate[];
} {
  const calls: RecordedCreate[] = [];
  const client = {
    async createAttachment(input: {
      issueId: string;
      url: string;
      title: string;
      subtitle?: string;
    }): Promise<Result<Attachment, RealLinearError>> {
      const record: RecordedCreate = {
        issueId: input.issueId,
        url: input.url,
        title: input.title,
      };
      if (input.subtitle !== undefined) {
        (record as { subtitle?: string }).subtitle = input.subtitle;
      }
      calls.push(record);
      return result;
    },
  } as unknown as LinearClient;
  return { client, calls };
}

describe("attachPrToIssue", () => {
  it("passes every field through to createAttachment and returns the Attachment", async () => {
    const { client, calls } = makeFakeClient(
      ok({ id: "a1", url: "https://github.com/example/r/pull/1" }),
    );
    const r = await attachPrToIssue({
      client,
      issueId: "issue-1",
      url: "https://github.com/example/r/pull/1",
      title: "PR #1",
      subtitle: "ready",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe("a1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      issueId: "issue-1",
      url: "https://github.com/example/r/pull/1",
      title: "PR #1",
      subtitle: "ready",
    });
  });

  it("omits subtitle entirely when not provided (doesn't send empty string)", async () => {
    const { client, calls } = makeFakeClient(ok({ id: "a1", url: "u" }));
    await attachPrToIssue({
      client,
      issueId: "issue-1",
      url: "https://example.com/pr/1",
      title: "PR",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      issueId: "issue-1",
      url: "https://example.com/pr/1",
      title: "PR",
    });
    // subtitle field literally absent:
    expect(Object.hasOwn(calls[0] as object, "subtitle")).toBe(false);
  });

  it("propagates LinearClient errors unchanged", async () => {
    const boom = new LinearError("forbidden", "nope");
    const { client } = makeFakeClient(err(boom));
    const r = await attachPrToIssue({
      client,
      issueId: "issue-1",
      url: "https://example.com/pr/1",
      title: "PR",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(boom);
  });
});
