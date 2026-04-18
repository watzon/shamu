/**
 * PR → issue attachment helper.
 *
 * Thin wrapper over `LinearClient.createAttachment`. Phase 6 expects a PR
 * link to surface as a Linear "attachment" on the issue (not a plain comment)
 * so Linear's UI renders it as a first-class object with status hooks into
 * the GitHub integration. Linear dedupes by URL, so re-submitting the same
 * PR link on a retry is safe — we don't carry a local dedup cache.
 *
 * The wrapper exists so call sites don't stutter:
 *
 *     await attachPrToIssue({ client, issueId, url, title })
 *
 * reads cleaner than passing `client.createAttachment(...)` around, and
 * gives the composition layer a single import to wire.
 */

import type { Attachment, LinearClient, LinearError } from "@shamu/linear-client";
import type { Result } from "@shamu/shared/result";

export interface AttachPrToIssueOptions {
  readonly client: LinearClient;
  readonly issueId: string;
  readonly url: string;
  readonly title: string;
  /** Optional subtitle (e.g. "ready for review"). Null-safe. */
  readonly subtitle?: string;
}

// Re-export `Attachment` so callers that only import this module don't have
// to chase the type back through `@shamu/linear-client`.
export type { Attachment } from "@shamu/linear-client";

export function attachPrToIssue(
  opts: AttachPrToIssueOptions,
): Promise<Result<Attachment, LinearError>> {
  const input: {
    issueId: string;
    url: string;
    title: string;
    subtitle?: string;
  } = {
    issueId: opts.issueId,
    url: opts.url,
    title: opts.title,
  };
  if (opts.subtitle !== undefined) input.subtitle = opts.subtitle;
  return opts.client.createAttachment(input);
}
