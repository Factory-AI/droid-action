import type { Octokits } from "../../api/client";

export interface FetchDroidCommentParams {
  owner: string;
  repo: string;
  commentId: number;
  isPullRequestReviewCommentEvent: boolean;
}

export interface FetchDroidCommentResult {
  comment: { body: string | null };
  isPRReviewComment: boolean;
}

/**
 * Fetches a comment from GitHub, trying both issue comment and PR review comment APIs.
 *
 * GitHub uses separate ID namespaces for review comments and issue comments.
 * The comment type doesn't always match the event type (e.g., a PR review comment
 * could have been created in a previous step, but now we're in a pull_request event).
 * This function tries both endpoints to handle all cases.
 */
export async function fetchDroidComment(
  octokit: Octokits,
  params: FetchDroidCommentParams,
): Promise<FetchDroidCommentResult> {
  const { owner, repo, commentId, isPullRequestReviewCommentEvent } = params;

  let comment: { body: string | null } | undefined;
  let isPRReviewComment = false;

  // First, try the endpoint matching the event type for efficiency
  if (isPullRequestReviewCommentEvent) {
    try {
      console.log(`Fetching PR review comment ${commentId}`);
      const { data: prComment } = await octokit.rest.pulls.getReviewComment({
        owner,
        repo,
        comment_id: commentId,
      });
      comment = { body: prComment.body ?? null };
      isPRReviewComment = true;
      console.log("Successfully fetched as PR review comment");
    } catch {
      // Fall through to try issue comment API
      console.log("PR review comment fetch failed, trying issue comment API");
    }
  }

  // Try issue comment API
  if (!comment) {
    try {
      console.log(`Fetching issue comment ${commentId}`);
      const { data: issueComment } = await octokit.rest.issues.getComment({
        owner,
        repo,
        comment_id: commentId,
      });
      comment = { body: issueComment.body ?? null };
      isPRReviewComment = false;
      console.log("Successfully fetched as issue comment");
    } catch (issueError) {
      // If event wasn't a PR review comment event, try review comment API as fallback
      if (!isPullRequestReviewCommentEvent) {
        console.log(
          "Issue comment fetch failed, trying PR review comment API",
        );
        try {
          const { data: prComment } = await octokit.rest.pulls.getReviewComment(
            {
              owner,
              repo,
              comment_id: commentId,
            },
          );
          comment = { body: prComment.body ?? null };
          isPRReviewComment = true;
          console.log("Successfully fetched as PR review comment");
        } catch {
          // Both APIs failed, throw the original issue error
          throw issueError;
        }
      } else {
        throw issueError;
      }
    }
  }

  if (!comment) {
    throw new Error("Failed to fetch comment");
  }

  return { comment, isPRReviewComment };
}
