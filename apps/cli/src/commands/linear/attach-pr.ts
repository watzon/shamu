/**
 * `shamu linear attach-pr` — attach a PR URL as a Linear attachment on
 * the given issue.
 *
 * Phase 6.C.3 / 6.D scope: manual-only today. The canonical flow doesn't
 * emit a PR URL in its outputs yet, so auto-attachment from the daemon
 * is a deferred followup. 6.D's integration test invokes this command
 * directly to simulate a completed-and-opened-PR pickup end-state.
 *
 * Thin wrapper over `attachPrToIssue` (which itself is a thin wrapper
 * over `LinearClient.createAttachment`). Exits OK on success, USAGE on
 * missing args, CREDENTIALS_ERROR on auth failure, INTERNAL on any
 * Linear-side error.
 */

import { LinearClient, resolveLinearApiKey } from "@shamu/linear-client";
import { attachPrToIssue } from "@shamu/linear-integration";
import { defineCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "../../exit-codes.ts";
import { writeDiag, writeHuman, writeJson } from "../../output.ts";
import { commonArgs, done, outputMode, withServices } from "../_shared.ts";

/** Derive a default attachment title from a URL ("github.com/<owner>/<repo>#<n>"). */
function deriveTitleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    // Common PR URL shape: https://github.com/<owner>/<repo>/pull/<n>
    const parts = u.pathname.split("/").filter(Boolean);
    if (u.hostname.endsWith("github.com") && parts.length >= 4 && parts[2] === "pull") {
      return `${parts[0]}/${parts[1]}#${parts[3]}`;
    }
    return `${u.hostname}${u.pathname}`;
  } catch {
    return url;
  }
}

export const linearAttachPrCommand = defineCommand({
  meta: {
    name: "attach-pr",
    description:
      "Attach a PR URL to a Linear issue as an attachment (Phase 6.D). Manual today; auto-attach from the canonical flow is a deferred followup.",
  },
  args: {
    ...commonArgs,
    issue: {
      type: "string",
      description: "Linear issue id.",
      required: true,
    },
    url: {
      type: "string",
      description: "Attachment URL (usually a PR link).",
      required: true,
    },
    title: {
      type: "string",
      description: "Attachment title. Default: derived from the URL.",
    },
    subtitle: {
      type: "string",
      description: "Optional attachment subtitle.",
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    const issueId = args.issue as string | undefined;
    if (typeof issueId !== "string" || issueId.length === 0) {
      writeDiag("linear attach-pr: --issue is required and must be non-empty");
      return done(ExitCode.USAGE);
    }
    const url = args.url as string | undefined;
    if (typeof url !== "string" || url.length === 0) {
      writeDiag("linear attach-pr: --url is required and must be non-empty");
      return done(ExitCode.USAGE);
    }

    const title = (args.title as string | undefined) ?? deriveTitleFromUrl(url);
    const subtitle = args.subtitle as string | undefined;

    const authRes = await resolveLinearApiKey({ env: process.env });
    if (!authRes.ok) {
      writeDiag(`linear attach-pr: ${authRes.error.message}`);
      return done(ExitCode.CREDENTIALS_ERROR);
    }

    // Optional API URL override — primarily a test seam so the CLI can
    // be driven against a local mock server without hitting Linear's
    // production endpoint. Operators with self-hosted Linear can also
    // use it. Env: `SHAMU_LINEAR_API_URL`.
    const apiUrlOverride = process.env.SHAMU_LINEAR_API_URL;
    const client = new LinearClient({
      apiKey: authRes.value.apiKey,
      ...(apiUrlOverride && apiUrlOverride.length > 0 ? { apiUrl: apiUrlOverride } : {}),
    });

    const attachInput = {
      client,
      issueId,
      url,
      title,
      ...(subtitle !== undefined && subtitle.length > 0 ? { subtitle } : {}),
    };
    const res = await attachPrToIssue(attachInput);
    if (!res.ok) {
      writeDiag(
        `linear attach-pr: createAttachment failed: ${res.error.kind}: ${res.error.message}`,
      );
      if (mode === "json") {
        writeJson(mode, {
          kind: "error",
          category: "linear-attach-pr",
          errorKind: res.error.kind,
          message: res.error.message,
        });
      }
      return done(ExitCode.INTERNAL);
    }

    svc.services.logger.info("linear attach-pr: attachment created", {
      issueId,
      url,
      attachmentId: res.value.id,
    });
    writeJson(mode, {
      kind: "linear-attach-pr-ok",
      issueId,
      url,
      attachmentId: res.value.id,
      attachmentUrl: res.value.url,
    });
    writeHuman(mode, `attached ${url} to ${issueId} (attachmentId=${res.value.id})`);
    return done(ExitCode.OK);
  },
});
