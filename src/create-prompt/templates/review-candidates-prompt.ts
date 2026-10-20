/**
 * GitHub Pass-1 (candidate generation) prompt — thin adapter.
 *
 * Delegates to the platform-agnostic builder in
 * `src/core/review/prompts/candidates.ts`, mapping the GitHub
 * `PreparedContext` shape onto the shared `ReviewPromptContext` and
 * supplying `GITHUB_TERMINOLOGY` (PR labels, github_* MCP tool names).
 */

import { generateCandidatesPrompt } from "../../core/review/prompts/candidates";
import { forkPrSourceNote } from "../fork-notice";
import { GITHUB_TERMINOLOGY } from "../terminology";
import type { PreparedContext } from "../types";

export function generateReviewCandidatesPrompt(
  context: PreparedContext,
): string {
  const prNumber = context.eventData.isPR
    ? context.eventData.prNumber
    : context.githubContext && "entityNumber" in context.githubContext
      ? String(context.githubContext.entityNumber)
      : "unknown";

  return generateCandidatesPrompt({
    terminology: GITHUB_TERMINOLOGY,
    entityNumber: prNumber,
    repoOrProject: context.repository,
    headRef: context.prBranchData?.headRefName ?? "unknown",
    headSha: context.prBranchData?.headRefOid ?? "unknown",
    baseRef: context.eventData.baseBranch ?? "unknown",
    diffPath:
      context.reviewArtifacts?.diffPath ?? "$RUNNER_TEMP/droid-prompts/pr.diff",
    commentsPath:
      context.reviewArtifacts?.commentsPath ??
      "$RUNNER_TEMP/droid-prompts/existing_comments.json",
    descriptionPath:
      context.reviewArtifacts?.descriptionPath ??
      "$RUNNER_TEMP/droid-prompts/pr_description.txt",
    candidatesPath:
      process.env.REVIEW_CANDIDATES_PATH ??
      "$RUNNER_TEMP/droid-prompts/review_candidates.json",
    includeSuggestions: context.includeSuggestions !== false,
    securityReviewEnabled: process.env.SECURITY_REVIEW_ENABLED === "true",
    sourceNote: forkPrSourceNote(
      context.prBranchData,
      context.eventData.baseBranch ?? "base",
    ),
  });
}
