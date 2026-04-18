/**
 * Unit tests for `LinearClient`.
 *
 * Every test wires a synthetic fetch stub — no real network calls, no real
 * API keys. Fixture key is the sentinel literal declared below.
 */

import { describe, expect, it } from "vitest";
import type { FetchLike } from "../client.ts";
import { LinearClient } from "../client.ts";
import { LinearError } from "../errors.ts";

const FIXTURE_KEY = "lin_api_TEST_fixture_key_do_not_use";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface StubCallOptions {
  status?: number;
  body?: unknown;
  bodyText?: string;
  headers?: Record<string, string>;
}

interface StubbedFetch {
  fn: FetchLike;
  calls: Recorded[];
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

function stubFetch(queue: StubCallOptions[]): StubbedFetch {
  const calls: Recorded[] = [];
  let idx = 0;
  const fn: FetchLike = async (input, init) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers: init?.headers ? { ...init.headers } : {},
      body: init?.body ?? "",
    });
    const spec = queue[idx];
    idx += 1;
    if (!spec) {
      throw new Error(`stub fetch: unexpected call #${idx} (no queued response)`);
    }
    if (spec.bodyText !== undefined) {
      return new Response(spec.bodyText, {
        status: spec.status ?? 200,
        headers: { "content-type": "application/json", ...(spec.headers ?? {}) },
      });
    }
    return jsonResponse(spec.status ?? 200, spec.body ?? {}, spec.headers);
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Fixtures (narrow, only the fields the narrowers consume)
// ---------------------------------------------------------------------------

const ISSUE_ID = "issue-1";
const TEAM_ID = "team-1";

function issuePayload(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      issue: {
        id: ISSUE_ID,
        identifier: "SHA-1",
        title: "test issue",
        description: null,
        url: "https://linear.app/shamu/issue/SHA-1",
        team: { id: TEAM_ID },
        state: { id: "state-todo", name: "Todo" },
        labels: { nodes: [{ id: "label-ready", name: "shamu:ready" }] },
        ...overrides,
      },
    },
  };
}

function labelsPayload(nodes: Array<{ id: string; name: string }>) {
  return {
    data: {
      team: {
        id: TEAM_ID,
        labels: { nodes },
      },
    },
  };
}

function statesPayload(nodes: Array<{ id: string; name: string; type?: string }>) {
  return {
    data: {
      team: {
        id: TEAM_ID,
        states: { nodes },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe("LinearClient construction", () => {
  it("requires a non-empty apiKey", () => {
    expect(() => new LinearClient({ apiKey: "", fetch: stubFetch([]).fn })).toThrow(LinearError);
  });

  it("sends the API key as a bare Authorization header (no Bearer prefix)", async () => {
    const stub = stubFetch([{ body: issuePayload() }]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    await c.getIssue(ISSUE_ID);
    const call = stub.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    expect(call.headers.authorization).toBe(FIXTURE_KEY);
    expect(call.headers.authorization).not.toMatch(/^Bearer /i);
  });

  it("defaults the URL to api.linear.app/graphql", async () => {
    const stub = stubFetch([{ body: issuePayload() }]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    await c.getIssue(ISSUE_ID);
    expect(stub.calls[0]?.url).toBe("https://api.linear.app/graphql");
  });

  it("honours apiUrl override", async () => {
    const stub = stubFetch([{ body: issuePayload() }]);
    const c = new LinearClient({
      apiKey: FIXTURE_KEY,
      apiUrl: "https://example.invalid/graphql",
      fetch: stub.fn,
    });
    await c.getIssue(ISSUE_ID);
    expect(stub.calls[0]?.url).toBe("https://example.invalid/graphql");
  });
});

// ---------------------------------------------------------------------------
// getIssue
// ---------------------------------------------------------------------------

describe("getIssue", () => {
  it("returns a narrowed Issue on happy path", async () => {
    const stub = stubFetch([{ body: issuePayload() }]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.getIssue(ISSUE_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe(ISSUE_ID);
    expect(r.value.teamId).toBe(TEAM_ID);
    expect(r.value.stateName).toBe("Todo");
    expect(r.value.labelNames).toEqual(["shamu:ready"]);
  });

  it("rejects empty ids with invalid_input", async () => {
    const stub = stubFetch([]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.getIssue("");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("invalid_input");
    expect(stub.calls).toHaveLength(0);
  });

  it("maps a null data.issue to not_found", async () => {
    const stub = stubFetch([{ body: { data: { issue: null } } }]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.getIssue(ISSUE_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// listLabels / listStates + cache
// ---------------------------------------------------------------------------

describe("listLabels / listStates and their caches", () => {
  it("listLabels populates the label cache", async () => {
    const stub = stubFetch([
      {
        body: labelsPayload([
          { id: "l1", name: "shamu:ready" },
          { id: "l2", name: "shamu:blocked" },
        ]),
      },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.listLabels(TEAM_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
  });

  it("shape error when team.labels.nodes is missing", async () => {
    const stub = stubFetch([{ body: { data: { team: { id: TEAM_ID, labels: null } } } }]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.listLabels(TEAM_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("shape");
  });

  it("listStates populates the state cache", async () => {
    const stub = stubFetch([
      {
        body: statesPayload([
          { id: "s1", name: "Todo", type: "unstarted" },
          { id: "s2", name: "Done", type: "completed" },
        ]),
      },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.listStates(TEAM_ID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((s) => s.name)).toEqual(["Todo", "Done"]);
  });
});

// ---------------------------------------------------------------------------
// addLabel / removeLabel — exercise cache reuse
// ---------------------------------------------------------------------------

describe("addLabel caches label lookups per team", () => {
  it("lists labels once per team, regardless of repeated add/remove calls", async () => {
    const stub = stubFetch([
      // 1. getIssue for addLabel #1
      { body: issuePayload() },
      // 2. listLabels (cache miss)
      {
        body: labelsPayload([
          { id: "label-ready", name: "shamu:ready" },
          { id: "label-blocked", name: "shamu:blocked" },
        ]),
      },
      // 3. issueAddLabel
      { body: { data: { issueAddLabel: { success: true } } } },
      // 4. getIssue for addLabel #2 (different label, same team)
      { body: issuePayload() },
      // 5. issueAddLabel (no listLabels — cache hit)
      { body: { data: { issueAddLabel: { success: true } } } },
      // 6. getIssue for removeLabel
      { body: issuePayload() },
      // 7. issueRemoveLabel
      { body: { data: { issueRemoveLabel: { success: true } } } },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });

    const r1 = await c.addLabel(ISSUE_ID, "shamu:ready");
    expect(r1.ok).toBe(true);
    const r2 = await c.addLabel(ISSUE_ID, "shamu:blocked");
    expect(r2.ok).toBe(true);
    const r3 = await c.removeLabel(ISSUE_ID, "shamu:ready");
    expect(r3.ok).toBe(true);

    // Count listLabels calls by inspecting operation names in bodies.
    const listLabelsCalls = stub.calls.filter((c) => c.body.includes("ShamuListLabels"));
    expect(listLabelsCalls).toHaveLength(1);
  });

  it("not_found when label name doesn't resolve", async () => {
    const stub = stubFetch([
      { body: issuePayload() },
      { body: labelsPayload([{ id: "l1", name: "shamu:ready" }]) },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.addLabel(ISSUE_ID, "does-not-exist");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("not_found");
  });

  it("case-insensitive label name matching", async () => {
    const stub = stubFetch([
      { body: issuePayload() },
      { body: labelsPayload([{ id: "l1", name: "Shamu:Ready" }]) },
      { body: { data: { issueAddLabel: { success: true } } } },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.addLabel(ISSUE_ID, "shamu:ready");
    expect(r.ok).toBe(true);
  });
});

describe("setIssueStatus caches state lookups per team", () => {
  it("lists states once per team across repeated calls", async () => {
    const stub = stubFetch([
      // 1. getIssue
      { body: issuePayload() },
      // 2. listStates
      {
        body: statesPayload([
          { id: "s1", name: "In Progress", type: "started" },
          { id: "s2", name: "Done", type: "completed" },
        ]),
      },
      // 3. issueUpdate
      {
        body: {
          data: {
            issueUpdate: {
              success: true,
              issue: { id: ISSUE_ID, state: { id: "s1", name: "In Progress" } },
            },
          },
        },
      },
      // 4. getIssue
      { body: issuePayload() },
      // 5. issueUpdate (cache hit, no listStates)
      {
        body: {
          data: {
            issueUpdate: {
              success: true,
              issue: { id: ISSUE_ID, state: { id: "s2", name: "Done" } },
            },
          },
        },
      },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r1 = await c.setIssueStatus(ISSUE_ID, "In Progress");
    expect(r1.ok).toBe(true);
    const r2 = await c.setIssueStatus(ISSUE_ID, "Done");
    expect(r2.ok).toBe(true);
    const listStatesCalls = stub.calls.filter((call) => call.body.includes("ShamuListStates"));
    expect(listStatesCalls).toHaveLength(1);
  });

  it("invalidateTeamCache forces a refresh", async () => {
    const stub = stubFetch([
      { body: issuePayload() },
      { body: statesPayload([{ id: "s1", name: "Done", type: "completed" }]) },
      {
        body: {
          data: {
            issueUpdate: {
              success: true,
              issue: { id: ISSUE_ID, state: { id: "s1", name: "Done" } },
            },
          },
        },
      },
      { body: issuePayload() },
      { body: statesPayload([{ id: "s1", name: "Done", type: "completed" }]) },
      {
        body: {
          data: {
            issueUpdate: {
              success: true,
              issue: { id: ISSUE_ID, state: { id: "s1", name: "Done" } },
            },
          },
        },
      },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    await c.setIssueStatus(ISSUE_ID, "Done");
    c.invalidateTeamCache();
    await c.setIssueStatus(ISSUE_ID, "Done");
    const listStatesCalls = stub.calls.filter((call) => call.body.includes("ShamuListStates"));
    expect(listStatesCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// createComment / updateComment
// ---------------------------------------------------------------------------

describe("createComment / updateComment", () => {
  it("createComment returns { id } on success", async () => {
    const stub = stubFetch([
      {
        body: {
          data: { commentCreate: { success: true, comment: { id: "comment-xyz" } } },
        },
      },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.createComment(ISSUE_ID, "hello");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe("comment-xyz");
  });

  it("updateComment returns { id } on success", async () => {
    const stub = stubFetch([
      {
        body: {
          data: { commentUpdate: { success: true, comment: { id: "comment-xyz" } } },
        },
      },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.updateComment("comment-xyz", "edited");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe("comment-xyz");
  });

  it("createComment surfaces shape error on success=false", async () => {
    const stub = stubFetch([
      { body: { data: { commentCreate: { success: false, comment: null } } } },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.createComment(ISSUE_ID, "hello");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("shape");
  });

  it("rejects empty body early as invalid_input", async () => {
    const stub = stubFetch([]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.createComment(ISSUE_ID, "");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("invalid_input");
    expect(stub.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createAttachment
// ---------------------------------------------------------------------------

describe("createAttachment", () => {
  it("sends attachmentCreate with the expected variables and returns { id, url }", async () => {
    const stub = stubFetch([
      {
        body: {
          data: {
            attachmentCreate: {
              success: true,
              attachment: {
                id: "attachment-abc",
                url: "https://github.com/example/repo/pull/42",
              },
            },
          },
        },
      },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.createAttachment({
      issueId: ISSUE_ID,
      url: "https://github.com/example/repo/pull/42",
      title: "PR #42",
      subtitle: "ready for review",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe("attachment-abc");
    expect(r.value.url).toBe("https://github.com/example/repo/pull/42");
    const call = stub.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    expect(call.body).toContain("ShamuCreateAttachment");
    const parsed = JSON.parse(call.body) as { variables: Record<string, unknown> };
    expect(parsed.variables).toMatchObject({
      issueId: ISSUE_ID,
      url: "https://github.com/example/repo/pull/42",
      title: "PR #42",
      subtitle: "ready for review",
    });
  });

  it("sends subtitle=null when omitted", async () => {
    const stub = stubFetch([
      {
        body: {
          data: {
            attachmentCreate: {
              success: true,
              attachment: { id: "a1", url: "https://example.com/pr/1" },
            },
          },
        },
      },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.createAttachment({
      issueId: ISSUE_ID,
      url: "https://example.com/pr/1",
      title: "PR",
    });
    expect(r.ok).toBe(true);
    const call = stub.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const parsed = JSON.parse(call.body) as { variables: Record<string, unknown> };
    expect(parsed.variables.subtitle).toBeNull();
  });

  it("surfaces shape error on success=false", async () => {
    const stub = stubFetch([
      { body: { data: { attachmentCreate: { success: false, attachment: null } } } },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.createAttachment({
      issueId: ISSUE_ID,
      url: "https://example.com/pr/1",
      title: "PR",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("shape");
  });

  it("rejects empty url with invalid_input without touching the wire", async () => {
    const stub = stubFetch([]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.createAttachment({ issueId: ISSUE_ID, url: "", title: "PR" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("invalid_input");
    expect(stub.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("Error handling", () => {
  it("network failure becomes kind=network", async () => {
    const fetchFn: FetchLike = () => Promise.reject(new Error("ECONNREFUSED"));
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: fetchFn });
    const r = await c.getIssue(ISSUE_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("network");
    expect(r.error.cause).toBeInstanceOf(Error);
  });

  it("HTTP 401 maps to unauthenticated", async () => {
    const stub = stubFetch([{ status: 401, body: { errors: [] } }]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.getIssue(ISSUE_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("unauthenticated");
    expect(r.error.detail.status).toBe(401);
  });

  it("HTTP 403 maps to forbidden", async () => {
    const stub = stubFetch([{ status: 403, body: {} }]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.getIssue(ISSUE_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("forbidden");
  });

  it("HTTP 404 maps to not_found", async () => {
    const stub = stubFetch([{ status: 404, body: {} }]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.getIssue(ISSUE_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("not_found");
  });

  it("HTTP 500 maps to http", async () => {
    const stub = stubFetch([{ status: 500, body: { errors: [] } }]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.getIssue(ISSUE_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("http");
    expect(r.error.detail.status).toBe(500);
  });

  it("non-JSON 200 body maps to shape", async () => {
    const stub = stubFetch([{ status: 200, bodyText: "not json" }]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.getIssue(ISSUE_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("shape");
  });

  it("200 with GraphQL errors[] maps to graphql (or specific kind)", async () => {
    const stub = stubFetch([
      {
        status: 200,
        body: {
          errors: [
            {
              message: "authentication required",
              extensions: { code: "AUTHENTICATION_ERROR" },
            },
          ],
        },
      },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.getIssue(ISSUE_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("unauthenticated");
    expect(r.error.detail.extensionsCode).toBe("AUTHENTICATION_ERROR");
  });

  it("200 with generic GraphQL error maps to graphql", async () => {
    const stub = stubFetch([
      {
        status: 200,
        body: {
          errors: [{ message: "something broke", extensions: { code: "INTERNAL" } }],
        },
      },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.getIssue(ISSUE_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("graphql");
    expect(r.error.detail.extensionsCode).toBe("INTERNAL");
  });
});

// ---------------------------------------------------------------------------
// Rate-limit handling
// ---------------------------------------------------------------------------

describe("Rate-limit detection", () => {
  it("HTTP 429 with Retry-After maps to rate_limited + retryAfterSeconds", async () => {
    const stub = stubFetch([
      {
        status: 429,
        body: {},
        headers: { "retry-after": "13" },
      },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.getIssue(ISSUE_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("rate_limited");
    expect(r.error.detail.retryAfterSeconds).toBe(13);
    expect(r.error.detail.status).toBe(429);
  });

  it("Linear's 400 + RATELIMITED extension maps to rate_limited", async () => {
    const resetMs = Date.now() + 60_000;
    const stub = stubFetch([
      {
        status: 400,
        body: {
          errors: [
            {
              message: "Rate limit exceeded",
              extensions: { code: "RATELIMITED" },
            },
          ],
        },
        headers: {
          "x-ratelimit-requests-limit": "5000",
          "x-ratelimit-requests-remaining": "0",
          "x-ratelimit-requests-reset": String(resetMs),
        },
      },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.getIssue(ISSUE_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("rate_limited");
    expect(r.error.detail.extensionsCode).toBe("RATELIMITED");
    expect(r.error.detail.resetAtMs).toBe(resetMs);
    expect(r.error.detail.retryAfterSeconds).toBeGreaterThanOrEqual(0);
  });

  it("200 body with RATELIMITED still maps to rate_limited", async () => {
    const stub = stubFetch([
      {
        status: 200,
        body: {
          errors: [{ message: "chill out", extensions: { code: "RATELIMITED" } }],
        },
        headers: { "retry-after": "7" },
      },
    ]);
    const c = new LinearClient({ apiKey: FIXTURE_KEY, fetch: stub.fn });
    const r = await c.getIssue(ISSUE_ID);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("rate_limited");
    expect(r.error.detail.retryAfterSeconds).toBe(7);
  });
});
