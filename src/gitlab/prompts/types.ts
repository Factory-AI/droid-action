/**
 * Shared shape passed to both the Pass-1 candidate-generation prompt and
 * the Pass-2 validator prompt. Mirrors the subset of GitHub's
 * `PreparedContext` that the review templates actually consume, but with
 * GitLab terminology (MR instead of PR, project path instead of repo
 * full_name) and without coupling to the GitHub action's webhook payload
 * types.
 *
 * Kept platform-specific on purpose for v1; a follow-up will extract a
 * platform-neutral context into `src/core/review/`.
 */

export type GitlabReviewPromptContext = {
  reviewSettings?: import("../../core/review/prompts/types").ReviewPromptSettings;
  projectPath: string;
  mrIid: number;
  mrTitle: string;
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
