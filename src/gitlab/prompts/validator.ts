/**
 * GitLab Pass-2 (validator) prompt — thin adapter.
 *
 * Delegates to the platform-agnostic builder in
 * `src/core/review/prompts/validator.ts` after mapping the GitLab
 * context shape onto the shared `ReviewPromptContext`.
 *
 * GitLab uses `postingMode: "file"`: Pass 2 writes the validated JSON and
 * stops there. `src/entrypoints/gitlab-post-review.ts` posts the approved
 * findings through the GitLab REST API afterwards, so neither pass is ever
 * given a tool that can write to the MR.
 */

import { generateValidatorPrompt } from "../../core/review/prompts/validator";
import { GITLAB_TERMINOLOGY } from "./terminology";
import type { GitlabReviewPromptContext } from "./types";

export function generateGitlabReviewValidatorPrompt(
  ctx: GitlabReviewPromptContext,
): string {
  return generateValidatorPrompt({
    terminology: GITLAB_TERMINOLOGY,
    postingMode: "file",
    entityNumber: ctx.mrIid,
    repoOrProject: ctx.projectPath,
    headRef: ctx.sourceBranch,
    headSha: ctx.headSha,
    baseRef: ctx.targetBranch,
    diffPath: ctx.diffPath,
    commentsPath: ctx.commentsPath,
    descriptionPath: ctx.descriptionPath,
    candidatesPath: ctx.candidatesPath,
    validatedPath: ctx.validatedPath,
    includeSuggestions: ctx.includeSuggestions,
    securityReviewEnabled: ctx.securityReviewEnabled,
  });
}
