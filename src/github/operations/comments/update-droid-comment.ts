import { Octokit } from "@octokit/rest";
import { retryWithBackoff, isGitHubTransientError } from "../../../utils/retry";

export type UpdateDroidCommentParams = {
  owner: string;
  repo: string;
  commentId: number;
  body: string;
  isPullRequestReviewComment: boolean;
};

export type UpdateDroidCommentResult = {
  id: number;
  html_url: string;
  updated_at: string;
};

/**
 * Updates a Droid comment on GitHub (either an issue/PR comment or a PR review comment)
 *
 * @param octokit - Authenticated Octokit instance
 * @param params - Parameters for updating the comment
 * @returns The updated comment details
 * @throws Error if the update fails
 */
export async function updateDroidComment(
  octokit: Octokit,
  params: UpdateDroidCommentParams,
): Promise<UpdateDroidCommentResult> {
  const { owner, repo, commentId, body, isPullRequestReviewComment } = params;

  let response;

  try {
    if (isPullRequestReviewComment) {
      // Try PR review comment API first
      response = await retryWithBackoff(
        () =>
          octokit.rest.pulls.updateReviewComment({
            owner,
            repo,
            comment_id: commentId,
            body,
          }),
        {
          maxAttempts: 3,
          initialDelayMs: 3000,
          maxDelayMs: 15000,
          shouldRetry: isGitHubTransientError,
        },
      );
    } else {
      // Use issue comment API (works for both issues and PR general comments)
      response = await retryWithBackoff(
        () =>
          octokit.rest.issues.updateComment({
            owner,
            repo,
            comment_id: commentId,
            body,
          }),
        {
          maxAttempts: 3,
          initialDelayMs: 3000,
          maxDelayMs: 15000,
          shouldRetry: isGitHubTransientError,
        },
      );
    }
  } catch (error: any) {
    // If PR review comment update fails with 404, fall back to issue comment API
    if (isPullRequestReviewComment && error.status === 404) {
      response = await retryWithBackoff(
        () =>
          octokit.rest.issues.updateComment({
            owner,
            repo,
            comment_id: commentId,
            body,
          }),
        {
          maxAttempts: 3,
          initialDelayMs: 3000,
          maxDelayMs: 15000,
          shouldRetry: isGitHubTransientError,
        },
      );
    } else {
      throw error;
    }
  }

  return {
    id: response.data.id,
    html_url: response.data.html_url,
    updated_at: response.data.updated_at,
  };
}
