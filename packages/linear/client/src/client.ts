/**
 * `LinearClient` — typed wrapper over Linear's GraphQL API.
 *
 * Scope: only the operations Phase 6 needs. Every public method returns
 * `Result<T, LinearError>`; no throws cross the boundary. Rate-limit and
 * GraphQL-error shapes are normalised into `LinearError.kind`.
 *
 * Implementation notes:
 *
 *   - Transport is Bun's native `fetch`. A caller-supplied `fetch` override
 *     is accepted purely for tests; production code doesn't override it.
 *   - Linear accepts personal API keys via `Authorization: <api_key>` — NO
 *     `Bearer` prefix. OAuth tokens are the reverse (`Bearer <token>`), but
 *     Phase 6 uses personal keys exclusively per the parent's decision.
 *   - Label-name → id and state-name → id lookups are cached per team for
 *     the lifetime of the client instance. The cache is populated lazily on
 *     first `listLabels(teamId)` / `listStates(teamId)` call and reused by
 *     `addLabel` / `removeLabel` / `setIssueStatus`. `invalidateTeamCache`
 *     lets callers force a refresh (e.g. after a human creates a new label).
 *   - No retries, no backoff — the caller (Phase 6 executor) owns retry
 *     policy because it has visibility into the surrounding flow. We do
 *     surface `retryAfterSeconds` in `LinearError.detail` so the caller can
 *     act.
 */

import type { Result } from "@shamu/shared/result";
import { err, ok } from "@shamu/shared/result";
import { isRateLimitCode, LinearError, parseResetHeader, parseRetryAfter } from "./errors.ts";
import {
  CREATE_ATTACHMENT_MUTATION,
  CREATE_COMMENT_MUTATION,
  GET_ISSUE_QUERY,
  ISSUE_ADD_LABEL_MUTATION,
  ISSUE_REMOVE_LABEL_MUTATION,
  LIST_LABELS_QUERY,
  LIST_STATES_QUERY,
  SET_ISSUE_STATUS_MUTATION,
  UPDATE_COMMENT_MUTATION,
} from "./graphql.ts";
import type { Attachment, CommentRef, Issue, Label, WorkflowState } from "./types.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const DEFAULT_LINEAR_API_URL = "https://api.linear.app/graphql" as const;

/** Abstract fetch signature compatible with both Bun's and Node's. */
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<Response>;

export interface LinearClientOptions {
  readonly apiKey: string;
  /** Override the API endpoint (tests / self-host). Default: Linear prod. */
  readonly apiUrl?: string;
  /** Override fetch (tests). Default: Bun's `fetch`. */
  readonly fetch?: FetchLike;
}

// ---------------------------------------------------------------------------
// GraphQL wire shapes (internal)
// ---------------------------------------------------------------------------

interface GraphQLErrorExtensions {
  readonly code?: string;
  readonly type?: string;
  readonly [key: string]: unknown;
}

interface GraphQLError {
  readonly message: string;
  readonly extensions?: GraphQLErrorExtensions;
  readonly path?: readonly (string | number)[];
}

interface GraphQLResponse<T> {
  readonly data?: T | null;
  readonly errors?: readonly GraphQLError[];
}

// ---------------------------------------------------------------------------
// Raw data shapes we parse out of Linear responses (narrow, internal)
// ---------------------------------------------------------------------------

interface RawIssue {
  id?: unknown;
  identifier?: unknown;
  title?: unknown;
  description?: unknown;
  url?: unknown;
  team?: { id?: unknown } | null;
  state?: { id?: unknown; name?: unknown } | null;
  labels?: { nodes?: Array<{ id?: unknown; name?: unknown } | null> | null } | null;
}

interface RawTeamLabels {
  team?: {
    id?: unknown;
    labels?: { nodes?: Array<{ id?: unknown; name?: unknown } | null> | null } | null;
  } | null;
}

interface RawTeamStates {
  team?: {
    id?: unknown;
    states?: {
      nodes?: Array<{ id?: unknown; name?: unknown; type?: unknown } | null> | null;
    } | null;
  } | null;
}

interface RawCommentPayload {
  commentCreate?: { success?: unknown; comment?: { id?: unknown } | null } | null;
  commentUpdate?: { success?: unknown; comment?: { id?: unknown } | null } | null;
}

interface RawIssueAddLabel {
  issueAddLabel?: { success?: unknown } | null;
}

interface RawIssueRemoveLabel {
  issueRemoveLabel?: { success?: unknown } | null;
}

interface RawIssueUpdate {
  issueUpdate?: { success?: unknown; issue?: { id?: unknown } | null } | null;
}

interface RawAttachmentCreate {
  attachmentCreate?: {
    success?: unknown;
    attachment?: { id?: unknown; url?: unknown } | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

function narrowIssue(raw: RawIssue | null | undefined): Issue | null {
  if (!raw) return null;
  const id = asNonEmptyString(raw.id);
  const identifier = asNonEmptyString(raw.identifier);
  const title = asString(raw.title);
  const url = asNonEmptyString(raw.url);
  const teamId = asNonEmptyString(raw.team?.id);
  const stateId = asNonEmptyString(raw.state?.id);
  const stateName = asString(raw.state?.name);
  if (id === null || identifier === null || title === null || url === null) return null;
  if (teamId === null || stateId === null || stateName === null) return null;
  const labelNodes = raw.labels?.nodes ?? [];
  const labelIds: string[] = [];
  const labelNames: string[] = [];
  for (const node of labelNodes) {
    const lid = asNonEmptyString(node?.id);
    const lname = asNonEmptyString(node?.name);
    if (lid !== null && lname !== null) {
      labelIds.push(lid);
      labelNames.push(lname);
    }
  }
  return {
    id,
    identifier,
    title,
    description: asString(raw.description),
    url,
    teamId,
    stateId,
    stateName,
    labelIds,
    labelNames,
  };
}

function narrowLabels(raw: RawTeamLabels | null | undefined): Label[] | null {
  const nodes = raw?.team?.labels?.nodes;
  if (!Array.isArray(nodes)) return null;
  const out: Label[] = [];
  for (const node of nodes) {
    const id = asNonEmptyString(node?.id);
    const name = asNonEmptyString(node?.name);
    if (id !== null && name !== null) out.push({ id, name });
  }
  return out;
}

function narrowStates(raw: RawTeamStates | null | undefined): WorkflowState[] | null {
  const nodes = raw?.team?.states?.nodes;
  if (!Array.isArray(nodes)) return null;
  const out: WorkflowState[] = [];
  for (const node of nodes) {
    const id = asNonEmptyString(node?.id);
    const name = asNonEmptyString(node?.name);
    const type = asNonEmptyString(node?.type) ?? "";
    if (id !== null && name !== null) out.push({ id, name, type });
  }
  return out;
}

// ---------------------------------------------------------------------------
// LinearClient
// ---------------------------------------------------------------------------

export class LinearClient {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: FetchLike;

  /** Label-name (lowercase) → label-id, keyed by teamId. */
  private readonly labelCache = new Map<string, Map<string, string>>();
  /** State-name (lowercase) → state-id, keyed by teamId. */
  private readonly stateCache = new Map<string, Map<string, string>>();

  constructor(options: LinearClientOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
      throw new LinearError("invalid_input", "LinearClient requires a non-empty apiKey");
    }
    this.apiKey = options.apiKey;
    this.apiUrl = options.apiUrl ?? DEFAULT_LINEAR_API_URL;
    const fallback =
      typeof globalThis.fetch === "function"
        ? (globalThis.fetch.bind(globalThis) as FetchLike)
        : undefined;
    const chosen = options.fetch ?? fallback;
    if (!chosen) {
      throw new LinearError(
        "invalid_input",
        "No fetch implementation available; pass options.fetch explicitly",
      );
    }
    this.fetchImpl = chosen;
  }

  /** Test / onboarding helper. Production callers go through the typed ops. */
  public invalidateTeamCache(teamId?: string): void {
    if (teamId === undefined) {
      this.labelCache.clear();
      this.stateCache.clear();
      return;
    }
    this.labelCache.delete(teamId);
    this.stateCache.delete(teamId);
  }

  // -------------------------------------------------------------------------
  // Public typed operations
  // -------------------------------------------------------------------------

  public async getIssue(id: string): Promise<Result<Issue, LinearError>> {
    const idCheck = requireNonEmptyInput(id, "id");
    if (idCheck) return err(idCheck);
    const res = await this.execute<{ issue?: RawIssue | null }>(
      GET_ISSUE_QUERY,
      { id },
      "getIssue",
    );
    if (!res.ok) return res;
    const narrowed = narrowIssue(res.value.issue);
    if (narrowed === null) {
      return err(
        new LinearError("not_found", `No issue with id ${id}`, {
          bodySnippet: `issue lookup returned ${res.value.issue ? "partial data" : "null"}`,
        }),
      );
    }
    return ok(narrowed);
  }

  public async listLabels(teamId: string): Promise<Result<Label[], LinearError>> {
    const check = requireNonEmptyInput(teamId, "teamId");
    if (check) return err(check);
    const res = await this.execute<RawTeamLabels>(LIST_LABELS_QUERY, { teamId }, "listLabels");
    if (!res.ok) return res;
    const labels = narrowLabels(res.value);
    if (labels === null) {
      return err(new LinearError("shape", "listLabels response missing team.labels.nodes"));
    }
    // Prime cache.
    const map = new Map<string, string>();
    for (const l of labels) map.set(l.name.toLowerCase(), l.id);
    this.labelCache.set(teamId, map);
    return ok(labels);
  }

  public async listStates(teamId: string): Promise<Result<WorkflowState[], LinearError>> {
    const check = requireNonEmptyInput(teamId, "teamId");
    if (check) return err(check);
    const res = await this.execute<RawTeamStates>(LIST_STATES_QUERY, { teamId }, "listStates");
    if (!res.ok) return res;
    const states = narrowStates(res.value);
    if (states === null) {
      return err(new LinearError("shape", "listStates response missing team.states.nodes"));
    }
    const map = new Map<string, string>();
    for (const s of states) map.set(s.name.toLowerCase(), s.id);
    this.stateCache.set(teamId, map);
    return ok(states);
  }

  public async addLabel(issueId: string, labelName: string): Promise<Result<true, LinearError>> {
    const c1 = requireNonEmptyInput(issueId, "issueId");
    if (c1) return err(c1);
    const c2 = requireNonEmptyInput(labelName, "labelName");
    if (c2) return err(c2);
    const lookup = await this.resolveLabelId(issueId, labelName);
    if (!lookup.ok) return lookup;
    const res = await this.execute<RawIssueAddLabel>(
      ISSUE_ADD_LABEL_MUTATION,
      { issueId, labelId: lookup.value },
      "addLabel",
    );
    if (!res.ok) return res;
    if (res.value.issueAddLabel?.success !== true) {
      return err(
        new LinearError("shape", "issueAddLabel returned success=false or missing success flag"),
      );
    }
    return ok(true);
  }

  public async removeLabel(issueId: string, labelName: string): Promise<Result<true, LinearError>> {
    const c1 = requireNonEmptyInput(issueId, "issueId");
    if (c1) return err(c1);
    const c2 = requireNonEmptyInput(labelName, "labelName");
    if (c2) return err(c2);
    const lookup = await this.resolveLabelId(issueId, labelName);
    if (!lookup.ok) return lookup;
    const res = await this.execute<RawIssueRemoveLabel>(
      ISSUE_REMOVE_LABEL_MUTATION,
      { issueId, labelId: lookup.value },
      "removeLabel",
    );
    if (!res.ok) return res;
    if (res.value.issueRemoveLabel?.success !== true) {
      return err(
        new LinearError("shape", "issueRemoveLabel returned success=false or missing success flag"),
      );
    }
    return ok(true);
  }

  public async createComment(
    issueId: string,
    body: string,
  ): Promise<Result<CommentRef, LinearError>> {
    const c1 = requireNonEmptyInput(issueId, "issueId");
    if (c1) return err(c1);
    const c2 = requireNonEmptyInput(body, "body");
    if (c2) return err(c2);
    const res = await this.execute<RawCommentPayload>(
      CREATE_COMMENT_MUTATION,
      { issueId, body },
      "createComment",
    );
    if (!res.ok) return res;
    const payload = res.value.commentCreate;
    const id = asNonEmptyString(payload?.comment?.id);
    if (payload?.success !== true || id === null) {
      return err(new LinearError("shape", "commentCreate missing success=true or comment.id"));
    }
    return ok({ id });
  }

  public async updateComment(
    commentId: string,
    body: string,
  ): Promise<Result<CommentRef, LinearError>> {
    const c1 = requireNonEmptyInput(commentId, "commentId");
    if (c1) return err(c1);
    const c2 = requireNonEmptyInput(body, "body");
    if (c2) return err(c2);
    const res = await this.execute<RawCommentPayload>(
      UPDATE_COMMENT_MUTATION,
      { id: commentId, body },
      "updateComment",
    );
    if (!res.ok) return res;
    const payload = res.value.commentUpdate;
    const id = asNonEmptyString(payload?.comment?.id);
    if (payload?.success !== true || id === null) {
      return err(new LinearError("shape", "commentUpdate missing success=true or comment.id"));
    }
    return ok({ id });
  }

  public async setIssueStatus(
    issueId: string,
    stateName: string,
  ): Promise<Result<true, LinearError>> {
    const c1 = requireNonEmptyInput(issueId, "issueId");
    if (c1) return err(c1);
    const c2 = requireNonEmptyInput(stateName, "stateName");
    if (c2) return err(c2);
    const lookup = await this.resolveStateId(issueId, stateName);
    if (!lookup.ok) return lookup;
    const res = await this.execute<RawIssueUpdate>(
      SET_ISSUE_STATUS_MUTATION,
      { id: issueId, stateId: lookup.value },
      "setIssueStatus",
    );
    if (!res.ok) return res;
    if (res.value.issueUpdate?.success !== true) {
      return err(new LinearError("shape", "issueUpdate returned success=false"));
    }
    return ok(true);
  }

  /**
   * Attach an external URL (usually a PR) to a Linear issue. Linear dedupes
   * by URL, so re-submitting the same URL returns the existing attachment
   * row — callers don't need a local dedup guard.
   */
  public async createAttachment(input: {
    readonly issueId: string;
    readonly url: string;
    readonly title: string;
    readonly subtitle?: string;
  }): Promise<Result<Attachment, LinearError>> {
    const c1 = requireNonEmptyInput(input.issueId, "issueId");
    if (c1) return err(c1);
    const c2 = requireNonEmptyInput(input.url, "url");
    if (c2) return err(c2);
    const c3 = requireNonEmptyInput(input.title, "title");
    if (c3) return err(c3);
    // subtitle is optional; null / empty strings are sent through to Linear.
    const variables: Record<string, unknown> = {
      issueId: input.issueId,
      url: input.url,
      title: input.title,
      subtitle: input.subtitle ?? null,
    };
    const res = await this.execute<RawAttachmentCreate>(
      CREATE_ATTACHMENT_MUTATION,
      variables,
      "createAttachment",
    );
    if (!res.ok) return res;
    const payload = res.value.attachmentCreate;
    const id = asNonEmptyString(payload?.attachment?.id);
    const url = asNonEmptyString(payload?.attachment?.url);
    if (payload?.success !== true || id === null || url === null) {
      return err(
        new LinearError("shape", "attachmentCreate missing success=true or attachment.id/url"),
      );
    }
    return ok({ id, url });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Look up a label id by name for a team. Needs the issue's teamId, which
   * we resolve via `getIssue` if we haven't seen it yet. Populates the cache.
   */
  private async resolveLabelId(
    issueId: string,
    labelName: string,
  ): Promise<Result<string, LinearError>> {
    const issueRes = await this.getIssue(issueId);
    if (!issueRes.ok) return issueRes;
    const teamId = issueRes.value.teamId;
    const key = labelName.toLowerCase();
    let cached = this.labelCache.get(teamId);
    if (!cached) {
      const labelsRes = await this.listLabels(teamId);
      if (!labelsRes.ok) return labelsRes;
      cached = this.labelCache.get(teamId) ?? new Map();
    }
    const labelId = cached.get(key);
    if (labelId === undefined) {
      return err(
        new LinearError("not_found", `No label named "${labelName}" on team ${teamId}`, {
          bodySnippet: `labelCache size=${cached.size}`,
        }),
      );
    }
    return ok(labelId);
  }

  private async resolveStateId(
    issueId: string,
    stateName: string,
  ): Promise<Result<string, LinearError>> {
    const issueRes = await this.getIssue(issueId);
    if (!issueRes.ok) return issueRes;
    const teamId = issueRes.value.teamId;
    const key = stateName.toLowerCase();
    let cached = this.stateCache.get(teamId);
    if (!cached) {
      const statesRes = await this.listStates(teamId);
      if (!statesRes.ok) return statesRes;
      cached = this.stateCache.get(teamId) ?? new Map();
    }
    const stateId = cached.get(key);
    if (stateId === undefined) {
      return err(
        new LinearError("not_found", `No workflow state named "${stateName}" on team ${teamId}`, {
          bodySnippet: `stateCache size=${cached.size}`,
        }),
      );
    }
    return ok(stateId);
  }

  /**
   * Core GraphQL executor. Returns the typed `data` on success; otherwise a
   * `LinearError` whose `kind` has already been normalised.
   */
  private async execute<T>(
    query: string,
    variables: Record<string, unknown>,
    opName: string,
  ): Promise<Result<T, LinearError>> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables, operationName: extractOpName(query) ?? opName }),
      });
    } catch (cause) {
      return err(new LinearError("network", `fetch failed for ${opName}`, {}, cause));
    }

    const bodyText = await safeReadBody(response);
    const headers = response.headers;

    // Linear returns 200 even for GraphQL-level errors; the body has `errors[]`.
    // Rate limits come back as either 400+`RATELIMITED` or 429+Retry-After.
    // Auth / permission errors may arrive as HTTP 401/403 with no body.
    if (response.ok) {
      const parsed = parseJson<GraphQLResponse<T>>(bodyText);
      if (!parsed) {
        return err(
          new LinearError("shape", `${opName}: response body was not valid JSON`, {
            status: response.status,
            bodySnippet: snippet(bodyText),
          }),
        );
      }
      if (parsed.errors && parsed.errors.length > 0) {
        return err(toGraphqlError(parsed.errors, response, headers, opName));
      }
      if (parsed.data === null || parsed.data === undefined) {
        return err(
          new LinearError("shape", `${opName}: response had neither data nor errors`, {
            status: response.status,
            bodySnippet: snippet(bodyText),
          }),
        );
      }
      return ok(parsed.data);
    }

    // Non-2xx path. Classify by status + body.
    return err(classifyHttpError(response, bodyText, opName));
  }
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

function requireNonEmptyInput(value: string, name: string): LinearError | null {
  if (typeof value !== "string" || value.length === 0) {
    return new LinearError("invalid_input", `${name} must be a non-empty string`);
  }
  return null;
}

function extractOpName(query: string): string | null {
  const m = /(?:query|mutation)\s+(\w+)/.exec(query);
  return m ? (m[1] ?? null) : null;
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function parseJson<T>(text: string): T | null {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const BODY_SNIPPET_LIMIT = 512;
function snippet(text: string): string {
  if (text.length <= BODY_SNIPPET_LIMIT) return text;
  return `${text.slice(0, BODY_SNIPPET_LIMIT)}…`;
}

function rateLimitDetailFromHeaders(headers: Headers): {
  retryAfterSeconds?: number;
  resetAtMs?: number;
} {
  const detail: { retryAfterSeconds?: number; resetAtMs?: number } = {};
  const retryAfter = parseRetryAfter(headers.get("retry-after"));
  if (retryAfter !== undefined) detail.retryAfterSeconds = retryAfter;
  const reset = parseResetHeader(headers.get("x-ratelimit-requests-reset"));
  if (reset !== undefined) {
    detail.resetAtMs = reset;
    if (detail.retryAfterSeconds === undefined) {
      const diff = Math.max(0, Math.ceil((reset - Date.now()) / 1000));
      detail.retryAfterSeconds = diff;
    }
  }
  return detail;
}

function toGraphqlError(
  errors: readonly GraphQLError[],
  response: Response,
  headers: Headers,
  opName: string,
): LinearError {
  // Look for a rate-limit code across all errors before falling through.
  for (const e of errors) {
    const extCode = e.extensions?.code;
    if (isRateLimitCode(extCode)) {
      const rl = rateLimitDetailFromHeaders(headers);
      const detail: {
        status: number;
        extensionsCode?: string;
        retryAfterSeconds?: number;
        resetAtMs?: number;
        path?: readonly (string | number)[];
      } = { status: response.status };
      if (extCode !== undefined) detail.extensionsCode = extCode;
      if (rl.retryAfterSeconds !== undefined) detail.retryAfterSeconds = rl.retryAfterSeconds;
      if (rl.resetAtMs !== undefined) detail.resetAtMs = rl.resetAtMs;
      if (e.path) detail.path = e.path;
      return new LinearError("rate_limited", `${opName}: ${e.message}`, detail);
    }
  }
  const primary = errors[0];
  if (!primary) {
    return new LinearError("graphql", `${opName}: empty errors[]`, { status: response.status });
  }
  const code = primary.extensions?.code;
  // Map a few well-known codes to specific kinds.
  if (code === "AUTHENTICATION_ERROR") {
    const detail: { status: number; extensionsCode: string; path?: readonly (string | number)[] } =
      { status: response.status, extensionsCode: code };
    if (primary.path) detail.path = primary.path;
    return new LinearError("unauthenticated", `${opName}: ${primary.message}`, detail);
  }
  if (code === "FORBIDDEN") {
    const detail: { status: number; extensionsCode: string; path?: readonly (string | number)[] } =
      { status: response.status, extensionsCode: code };
    if (primary.path) detail.path = primary.path;
    return new LinearError("forbidden", `${opName}: ${primary.message}`, detail);
  }
  if (code === "NOT_FOUND" || code === "ENTITY_NOT_FOUND") {
    const detail: { status: number; extensionsCode: string; path?: readonly (string | number)[] } =
      { status: response.status, extensionsCode: code };
    if (primary.path) detail.path = primary.path;
    return new LinearError("not_found", `${opName}: ${primary.message}`, detail);
  }
  const detail: {
    status: number;
    extensionsCode?: string;
    path?: readonly (string | number)[];
  } = { status: response.status };
  if (code !== undefined) detail.extensionsCode = code;
  if (primary.path) detail.path = primary.path;
  return new LinearError("graphql", `${opName}: ${primary.message}`, detail);
}

function classifyHttpError(response: Response, bodyText: string, opName: string): LinearError {
  const status = response.status;
  const headers = response.headers;

  // 429: canonical rate-limit signal.
  if (status === 429) {
    const rl = rateLimitDetailFromHeaders(headers);
    return new LinearError("rate_limited", `${opName}: HTTP 429`, {
      status,
      ...(rl.retryAfterSeconds !== undefined ? { retryAfterSeconds: rl.retryAfterSeconds } : {}),
      ...(rl.resetAtMs !== undefined ? { resetAtMs: rl.resetAtMs } : {}),
      bodySnippet: snippet(bodyText),
    });
  }

  // 400 may carry a RATELIMITED GraphQL error Linear-style; also 401/403/404.
  const parsed = parseJson<GraphQLResponse<unknown>>(bodyText);
  if (parsed?.errors && parsed.errors.length > 0) {
    return toGraphqlError(parsed.errors, response, headers, opName);
  }

  if (status === 401) {
    return new LinearError("unauthenticated", `${opName}: HTTP 401`, {
      status,
      bodySnippet: snippet(bodyText),
    });
  }
  if (status === 403) {
    return new LinearError("forbidden", `${opName}: HTTP 403`, {
      status,
      bodySnippet: snippet(bodyText),
    });
  }
  if (status === 404) {
    return new LinearError("not_found", `${opName}: HTTP 404`, {
      status,
      bodySnippet: snippet(bodyText),
    });
  }
  return new LinearError("http", `${opName}: HTTP ${status}`, {
    status,
    bodySnippet: snippet(bodyText),
  });
}
