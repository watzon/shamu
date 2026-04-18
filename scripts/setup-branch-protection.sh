#!/usr/bin/env bash
#
# Shamu branch-protection bootstrap.
#
# PLAN.md Phase 5.C (Quality bars): shamu's own repo must enforce the
# agent-ci gate. Branch protection is applied through the GitHub API,
# not by committing code, so this script is the delivery vehicle.
#
# Scope:
#   - main                     — default branch, the trunk
#   - shamu/integration/*      — integration branches created by the
#                                orchestrator for multi-run fan-in
#
# Rules applied (both targets):
#   - Require status check: "CI / ubuntu-latest" (see .github/workflows/ci.yml)
#   - Require signed commits
#   - Require linear history
#   - Require 1 PR review approval
#   - Disallow force pushes
#   - Disallow deletions
#
# Two passes:
#   1. GitHub rulesets (modern; pattern-aware, supports fnmatch targets).
#   2. Classic branch protection on `main` (belt-and-braces fallback for
#      tools that still read the old endpoint).
#
# Dev-laptop tooling. This script mutates GitHub repo settings; the
# watchdog test suite does not exercise it. Re-running is safe: the
# underlying endpoints are PUT semantics (overwrite-in-place).
#
# Preconditions:
#   - gh CLI installed and authenticated (gh auth status)
#   - authenticated user has "Admin" access on the target repo
#     (branch protection and rulesets both require it)
#
# Usage:
#   scripts/setup-branch-protection.sh                 # auto-detect repo from git remote
#   scripts/setup-branch-protection.sh watzon/shamu    # explicit owner/repo
#   GITHUB_REPO=watzon/shamu scripts/setup-branch-protection.sh
#   scripts/setup-branch-protection.sh --dry-run       # print actions; no API calls

set -euo pipefail

# Required status check context. GitHub Actions reports check-run names
# as the job name (e.g. "ubuntu-latest") not the PR-UI-displayed form
# (e.g. "CI / ubuntu-latest"). Rulesets compare against the raw check-run
# name; using the UI form here silently disables the gate because no
# check ever matches. Renaming the `ubuntu-latest` job in ci.yml breaks
# this gate — edit both in the same PR.
REQUIRED_CHECK="ubuntu-latest"
# Solo maintainer + agent-swarm authoring means every PR has the same
# author as the only reviewer; GitHub's default "author cannot self-review"
# rule would deadlock every merge. The CI gate (required status check
# above) remains the load-bearing quality bar; reviews are 0 by design,
# not by accident. If a second reviewer joins the project, bump this to
# >= 1 and re-run the script.
REQUIRED_APPROVALS=0
DRY_RUN=0
REPO_ARG=""

usage() {
  cat <<USAGE
Usage: $0 [--dry-run] [owner/repo]

Flags:
  --dry-run       Print the gh api calls that would be made; do not execute.
  -h, --help      Show this help.

Environment:
  GITHUB_REPO     Fallback source for owner/repo if no positional arg is given.

The effective repo is resolved in this order:
  1. positional argument
  2. \$GITHUB_REPO
  3. parsed from \`git remote get-url origin\`
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) echo "error: unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [ -n "$REPO_ARG" ]; then
        echo "error: unexpected positional argument: $1" >&2
        exit 2
      fi
      REPO_ARG="$1"
      ;;
  esac
  shift
done

resolve_repo() {
  if [ -n "$REPO_ARG" ]; then
    printf '%s' "$REPO_ARG"
    return 0
  fi
  if [ -n "${GITHUB_REPO:-}" ]; then
    printf '%s' "$GITHUB_REPO"
    return 0
  fi
  local url
  if ! url=$(git remote get-url origin 2>/dev/null); then
    echo "error: no repo specified and \`git remote get-url origin\` failed" >&2
    echo "       pass owner/repo as the first positional argument, or set GITHUB_REPO." >&2
    exit 2
  fi
  # Accept both https and ssh forms:
  #   https://github.com/owner/repo(.git)?
  #   git@github.com:owner/repo(.git)?
  local slug
  slug=$(printf '%s' "$url" | sed -nE 's#^.*github\.com[/:]([^/]+)/([^/]+)$#\1/\2#p' | sed -E 's/\.git$//')
  if [ -z "$slug" ]; then
    echo "error: could not parse owner/repo from origin URL: $url" >&2
    exit 2
  fi
  printf '%s' "$slug"
}

REPO=$(resolve_repo)

echo "Target repo:          $REPO"
echo "Required status check: $REQUIRED_CHECK"
echo "Required approvals:    $REQUIRED_APPROVALS"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "Mode:                  dry-run (no API calls will be made)"
else
  echo "Mode:                  apply"
fi
echo

# -----------------------------------------------------------------------------
# Preconditions.
# -----------------------------------------------------------------------------

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found on PATH. Install from https://cli.github.com/" >&2
  exit 2
fi

if [ "$DRY_RUN" -eq 0 ]; then
  if ! gh auth status >/dev/null 2>&1; then
    echo "error: gh is not authenticated. Run \`gh auth login\` first." >&2
    exit 2
  fi
fi

# -----------------------------------------------------------------------------
# Ruleset bodies (heredoc JSON).
#
# We build two ruleset payloads — one targeting `main` (branch name), one
# targeting `shamu/integration/*` (fnmatch glob). The API upserts by name
# so re-running replaces fields rather than duplicating rules.
# -----------------------------------------------------------------------------

ruleset_body() {
  # $1 = ruleset name
  # $2 = include-ref pattern (e.g. "refs/heads/main" or "refs/heads/shamu/integration/*")
  local name="$1"
  local pattern="$2"
  cat <<JSON
{
  "name": "$name",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["$pattern"],
      "exclude": []
    }
  },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "required_signatures" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": $REQUIRED_APPROVALS,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "$REQUIRED_CHECK" }
        ]
      }
    }
  ]
}
JSON
}

apply_ruleset() {
  # $1 = ruleset name
  # $2 = include-ref pattern
  local name="$1"
  local pattern="$2"
  local body
  body=$(ruleset_body "$name" "$pattern")

  echo "[ruleset] $name  →  $pattern"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "$body"
    echo
    return 0
  fi

  # Upsert: list existing rulesets, find one by name, PUT if present else POST.
  local existing_id
  existing_id=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$name\") | .id" 2>/dev/null || true)

  if [ -n "$existing_id" ]; then
    echo "  updating existing ruleset id=$existing_id"
    if ! gh api --method PUT "repos/$REPO/rulesets/$existing_id" --input - <<<"$body" >/dev/null; then
      echo "error: PUT repos/$REPO/rulesets/$existing_id failed for ruleset \"$name\"" >&2
      exit 1
    fi
  else
    echo "  creating new ruleset"
    if ! gh api --method POST "repos/$REPO/rulesets" --input - <<<"$body" >/dev/null; then
      echo "error: POST repos/$REPO/rulesets failed for ruleset \"$name\"" >&2
      exit 1
    fi
  fi
  echo "  ok"
  echo
}

classic_protection_body() {
  cat <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["$REQUIRED_CHECK"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": $REQUIRED_APPROVALS
  },
  "required_signatures": true,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "restrictions": null,
  "required_conversation_resolution": false
}
JSON
}

apply_classic_main() {
  local body
  body=$(classic_protection_body)
  echo "[classic] repos/$REPO/branches/main/protection"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "$body"
    echo
    return 0
  fi
  if ! gh api --method PUT "repos/$REPO/branches/main/protection" --input - <<<"$body" >/dev/null; then
    echo "error: PUT repos/$REPO/branches/main/protection failed" >&2
    exit 1
  fi
  # `required_signatures` on the classic endpoint isn't accepted inside the
  # main PUT body by every GitHub API version — follow up with the dedicated
  # sub-endpoint to be sure. Safe to re-run.
  if ! gh api --method POST "repos/$REPO/branches/main/protection/required_signatures" >/dev/null 2>&1; then
    # Non-fatal: may already be enabled or the account may not have the
    # feature. Warn and continue.
    echo "warn: could not POST required_signatures sub-endpoint (may already be set)" >&2
  fi
  echo "  ok"
  echo
}

# -----------------------------------------------------------------------------
# Drive.
# -----------------------------------------------------------------------------

apply_ruleset "shamu-main-protection"            "refs/heads/main"
apply_ruleset "shamu-integration-protection"     "refs/heads/shamu/integration/*"
apply_classic_main

echo "Done."
