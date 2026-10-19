/**
 * Bitbucket Pass-1 / Pass-2 prompts: thin adapters over the shared
 * builders in `src/core/review/prompts/`. Like GitLab, Bitbucket posts in
 * `"file"` mode: the passes write JSON and a CI step posts the result.
 */

import { generateCandidatesPrompt } from "../core/review/prompts/candidates";
import { generateValidatorPrompt } from "../core/review/prompts/validator";
import type { ReviewTerminology } from "../core/review/prompts/types";

export const BITBUCKET_TERMINOLOGY: ReviewTerminology = {
  entityNoun: "PR",
  entityNumberSigil: "#",
  platformName: "Bitbucket",
  repoLabel: "Repository",
  entityNumberLabel: "PR ID",
  headRefLabel: "PR Source Branch",
  headShaLabel: "PR Head SHA",
  baseRefLabel: "PR Destination Branch",
  baseRefShortLabel: "destination branch",
  descriptionLabel: "PR Description",
  diffLabel: "Full PR Diff",
  metaRepoKey: "repo",
  metaEntityNumberKey: "prId",
  metaBaseRefKey: "destinationBranch",
  repoExample: "workspace/repo",
  pathFieldDescription:
    'Relative file path (use the new path from the diff, e.g., "src/index.ts")',
  lineFieldDescription:
    "Target line number in the new file (single-line) or end line number (multi-line). Must be a positive integer. " +
    "Must be a line that appears in the PR diff (an added or context line inside a hunk); " +
    "Bitbucket cannot anchor inline comments to lines outside the diff, so a finding about " +
    "untouched code should anchor to the nearest related changed line instead.",
  mutationToolForbiddance:
    "(no PR comments, tasks, description edits, approvals, or build statuses — " +
    "whether through an MCP tool, the Bitbucket REST API, or `curl`)",
  trackingCommentName: "tracking comment",
};

export type BitbucketReviewPromptContext = {
  repoFullName: string;
  prId: number;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  diffPath: string;
  commentsPath: string;
  descriptionPath: string;
  candidatesPath: string;
  validatedPath: string;
  includeSuggestions: boolean;
  securityReviewEnabled: boolean;
};

function shared(ctx: BitbucketReviewPromptContext) {
  return {
    terminology: BITBUCKET_TERMINOLOGY,
    entityNumber: ctx.prId,
    repoOrProject: ctx.repoFullName,
    headRef: ctx.sourceBranch,
    headSha: ctx.headSha,
    baseRef: ctx.targetBranch,
    diffPath: ctx.diffPath,
    commentsPath: ctx.commentsPath,
    descriptionPath: ctx.descriptionPath,
    candidatesPath: ctx.candidatesPath,
    includeSuggestions: ctx.includeSuggestions,
    securityReviewEnabled: ctx.securityReviewEnabled,
  };
}

export function generateBitbucketCandidatesPrompt(
  ctx: BitbucketReviewPromptContext,
): string {
  return generateCandidatesPrompt(shared(ctx));
}

export function generateBitbucketValidatorPrompt(
  ctx: BitbucketReviewPromptContext,
): string {
  return generateValidatorPrompt({
    ...shared(ctx),
    postingMode: "file",
    validatedPath: ctx.validatedPath,
  });
}
