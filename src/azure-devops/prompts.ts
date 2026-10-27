/**
 * Azure DevOps adapters for the shared Pass-1 / Pass-2 review prompts.
 *
 * Both passes run in `postingMode: "file"`: the agent never holds a tool
 * or credential that can write to the pull request. The CI step
 * `azure-devops-post-review` posts the validated findings afterwards.
 */

import { generateCandidatesPrompt } from "../core/review/prompts/candidates";
import { generateValidatorPrompt } from "../core/review/prompts/validator";
import type { ReviewTerminology } from "../core/review/prompts/types";

export const AZURE_DEVOPS_TERMINOLOGY: ReviewTerminology = {
  entityNoun: "PR",
  entityNumberSigil: "!",
  platformName: "Azure DevOps",
  repoLabel: "Repository",
  entityNumberLabel: "PR ID",
  headRefLabel: "PR Source Branch",
  headShaLabel: "PR Source Commit",
  baseRefLabel: "PR Target Branch",
  baseRefShortLabel: "target branch",
  descriptionLabel: "PR Description",
  diffLabel: "Full PR Diff",
  metaRepoKey: "repository",
  metaEntityNumberKey: "prId",
  metaBaseRefKey: "targetBranch",
  repoExample: "project/repository",
  pathFieldDescription:
    'Relative file path (use the new path from the diff, e.g., "src/index.ts")',
  lineFieldDescription:
    "Target line number in the new file (single-line) or end line number (multi-line). Must be a positive integer. " +
    "Must be a line that appears in the PR diff (an added or context line inside a hunk); " +
    "a comment on a line outside the diff is posted as a general PR comment instead of inline, so a finding about " +
    "untouched code should anchor to the nearest related changed line.",
  mutationToolForbiddance:
    "(no PR threads, comments, description edits, votes, or status changes — " +
    "whether through an MCP tool, the Azure DevOps REST API, `az repos`, or `curl`)",
  trackingCommentName: "sticky tracking comment",
};

export type AzureDevopsReviewPromptContext = {
  repository: string;
  pullRequestId: number;
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

function shared(ctx: AzureDevopsReviewPromptContext) {
  return {
    terminology: AZURE_DEVOPS_TERMINOLOGY,
    entityNumber: ctx.pullRequestId,
    repoOrProject: ctx.repository,
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

export function generateAzureDevopsCandidatesPrompt(
  ctx: AzureDevopsReviewPromptContext,
): string {
  return generateCandidatesPrompt(shared(ctx));
}

export function generateAzureDevopsValidatorPrompt(
  ctx: AzureDevopsReviewPromptContext,
): string {
  return generateValidatorPrompt({
    ...shared(ctx),
    postingMode: "file",
    validatedPath: ctx.validatedPath,
  });
}
