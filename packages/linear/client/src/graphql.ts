/**
 * GraphQL query / mutation string constants.
 *
 * These are kept deliberately narrow — only the fields declared in ./types.ts
 * are selected. Callers that need broader shapes should extend this module and
 * a matching parser in ./client.ts, never pass ad-hoc queries.
 *
 * The shapes live here as plain string constants (no `gql` tag, no codegen) to
 * keep the dep surface at literally zero — Bun's native `fetch` does the rest.
 */

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const GET_ISSUE_QUERY = /* GraphQL */ `
  query ShamuGetIssue($id: String!) {
    issue(id: $id) {
      id
      identifier
      title
      description
      url
      team {
        id
      }
      state {
        id
        name
      }
      labels {
        nodes {
          id
          name
        }
      }
    }
  }
`;

export const LIST_LABELS_QUERY = /* GraphQL */ `
  query ShamuListLabels($teamId: String!) {
    team(id: $teamId) {
      id
      labels(first: 250) {
        nodes {
          id
          name
        }
      }
    }
  }
`;

export const LIST_STATES_QUERY = /* GraphQL */ `
  query ShamuListStates($teamId: String!) {
    team(id: $teamId) {
      id
      states(first: 250) {
        nodes {
          id
          name
          type
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * `issueAddLabel` / `issueRemoveLabel` are lossless on duplicates — re-adding
 * an already-attached label is a no-op on Linear's side. We still gate on the
 * local cache first to save a round-trip when the current state is known.
 */
export const ISSUE_ADD_LABEL_MUTATION = /* GraphQL */ `
  mutation ShamuIssueAddLabel($issueId: String!, $labelId: String!) {
    issueAddLabel(id: $issueId, labelId: $labelId) {
      success
    }
  }
`;

export const ISSUE_REMOVE_LABEL_MUTATION = /* GraphQL */ `
  mutation ShamuIssueRemoveLabel($issueId: String!, $labelId: String!) {
    issueRemoveLabel(id: $issueId, labelId: $labelId) {
      success
    }
  }
`;

export const CREATE_COMMENT_MUTATION = /* GraphQL */ `
  mutation ShamuCreateComment($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment {
        id
      }
    }
  }
`;

export const UPDATE_COMMENT_MUTATION = /* GraphQL */ `
  mutation ShamuUpdateComment($id: String!, $body: String!) {
    commentUpdate(id: $id, input: { body: $body }) {
      success
      comment {
        id
      }
    }
  }
`;

/**
 * Linear exposes status via `issueUpdate` with a `stateId`. We resolve the
 * name → id via `listStates` (cached) before firing this.
 */
export const SET_ISSUE_STATUS_MUTATION = /* GraphQL */ `
  mutation ShamuSetIssueStatus($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) {
      success
      issue {
        id
        state {
          id
          name
        }
      }
    }
  }
`;

/**
 * `attachmentCreate` attaches an external URL (typically a PR) to a Linear
 * issue. Linear dedupes by URL: re-submitting the same URL returns the
 * existing attachment, so callers don't need a local dedup list.
 */
export const CREATE_ATTACHMENT_MUTATION = /* GraphQL */ `
  mutation ShamuCreateAttachment(
    $issueId: String!
    $url: String!
    $title: String!
    $subtitle: String
  ) {
    attachmentCreate(
      input: { issueId: $issueId, url: $url, title: $title, subtitle: $subtitle }
    ) {
      success
      attachment {
        id
        url
      }
    }
  }
`;
