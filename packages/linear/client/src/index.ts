/**
 * `@shamu/linear-client` — public surface.
 *
 * Phase 6.A: Linear auth (personal API key) + a typed GraphQL client covering
 * only the operations the canonical flow uses. OAuth 2.1 DCR against
 * `mcp.linear.app/mcp` is deferred; see PLAN.md §§ Phased delivery → Phase 6.
 */

export {
  LINEAR_CREDENTIAL_ACCOUNT,
  LINEAR_CREDENTIAL_SERVICE,
  type ResolvedLinearApiKey,
  type ResolveLinearApiKeyOptions,
  resolveLinearApiKey,
} from "./auth.ts";
export {
  DEFAULT_LINEAR_API_URL,
  type FetchLike,
  LinearClient,
  type LinearClientOptions,
} from "./client.ts";
export {
  isRateLimitCode,
  LinearAuthError,
  type LinearAuthErrorReason,
  LinearError,
  type LinearErrorDetail,
  type LinearErrorKind,
  parseResetHeader,
  parseRetryAfter,
} from "./errors.ts";
export {
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
export type { Attachment, Comment, CommentRef, Issue, Label, WorkflowState } from "./types.ts";
