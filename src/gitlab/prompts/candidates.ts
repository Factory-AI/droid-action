/**
 * GitLab Pass-1 (candidate generation) prompt — thin adapter.
 *
 * Delegates to the platform-agnostic builder in
 * `src/core/review/prompts/candidates.ts` after mapping the GitLab
 * context shape onto the shared `ReviewPromptContext` and supplying
 * `GITLAB_TERMINOLOGY` (PR→MR labels, MR-mutation forbiddance, etc.).
 *
 * Neither pass may write to the MR on GitLab: Pass 1 produces candidates,
 * Pass 2 validates them, and a CI step posts the result through the REST
 * API. The shared builder states that, and `--enabled-tools` on both
 * `droid exec` invocations withholds any MR-mutation tool.
 */

import { generateCandidatesPrompt } from "../../core/review/prompts/candidates";
import { GITLAB_TERMINOLOGY } from "./terminology";
import type { GitlabReviewPromptContext } from "./types";

export function generateGitlabReviewCandidatesPrompt(
  ctx: GitlabReviewPromptContext,
): string {
  return generateCandidatesPrompt({
    terminology: GITLAB_TERMINOLOGY,
    entityNumber: ctx.mrIid,
    repoOrProject: ctx.projectPath,
    headRef: ctx.sourceBranch,
    headSha: ctx.headSha,
    baseRef: ctx.targetBranch,
    diffPath: ctx.diffPath,
    commentsPath: ctx.commentsPath,
    descriptionPath: ctx.descriptionPath,
    candidatesPath: ctx.candidatesPath,
    includeSuggestions: ctx.includeSuggestions,
    securityReviewEnabled: ctx.securityReviewEnabled,
  });
}
