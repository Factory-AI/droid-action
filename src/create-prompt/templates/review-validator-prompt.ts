/**
 * GitHub Pass-2 (validator) prompt — thin adapter.
 *
 * Delegates to the platform-agnostic builder in
 * `src/core/review/prompts/validator.ts`, mapping the GitHub
 * `PreparedContext` shape onto the shared `ReviewPromptContext` and
 * supplying `GITHUB_TERMINOLOGY`. GitHub uses file-only posting: the
 * validator writes JSON, then a deterministic CI step posts it.
 */

import { generateValidatorPrompt } from "../../core/review/prompts/validator";
import { GITHUB_TERMINOLOGY } from "../terminology";
import type { PreparedContext } from "../types";

export function generateReviewValidatorPrompt(
  context: PreparedContext,
): string {
  const prNumber = context.eventData.isPR
    ? context.eventData.prNumber
    : context.githubContext && "entityNumber" in context.githubContext
      ? String(context.githubContext.entityNumber)
      : "unknown";

  return generateValidatorPrompt({
    terminology: GITHUB_TERMINOLOGY,
    postingMode: "file",
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
    validatedPath:
      process.env.REVIEW_VALIDATED_PATH ??
      "$RUNNER_TEMP/droid-prompts/review_validated.json",
    includeSuggestions: context.includeSuggestions !== false,
    securityReviewEnabled: process.env.SECURITY_REVIEW_ENABLED === "true",
  });
}
