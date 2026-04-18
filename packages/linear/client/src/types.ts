/**
 * Minimal typed shapes for the Linear entities @shamu/linear-client returns.
 *
 * These are NOT a full mirror of Linear's schema — we cherry-pick only the
 * fields the Phase 6 plan actually consumes. Defensive parsers narrow raw
 * responses into these shapes; anything else is dropped. That keeps the
 * TypeScript surface tight and the API-version coupling shallow.
 */

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export interface Issue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  readonly teamId: string;
  readonly stateId: string;
  readonly stateName: string;
  readonly labelIds: readonly string[];
  readonly labelNames: readonly string[];
}

// ---------------------------------------------------------------------------
// Comment
// ---------------------------------------------------------------------------

export interface Comment {
  readonly id: string;
  readonly body: string;
}

/** Create / update comment response is narrowed to just the id. */
export interface CommentRef {
  readonly id: string;
}

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------

export interface Label {
  readonly id: string;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Workflow state
// ---------------------------------------------------------------------------

export interface WorkflowState {
  readonly id: string;
  readonly name: string;
  /**
   * Linear's state "type" column: backlog | unstarted | started | completed |
   * canceled | triage. We keep it as string to avoid chasing schema drift.
   */
  readonly type: string;
}

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

/**
 * Narrowed response shape from `attachmentCreate`. We keep just `id` + `url`
 * because Phase 6 only cares about round-tripping the PR link. Linear dedupes
 * by URL: submitting the same URL twice returns the same attachment.
 */
export interface Attachment {
  readonly id: string;
  readonly url: string;
}
