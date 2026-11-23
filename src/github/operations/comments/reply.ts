import { redactCredentials } from "../../../utils/redact-credentials";
import { retryWithBackoff } from "../../../utils/retry";

type ReplyClient = {
  rest: {
    pulls: {
      createReplyForReviewComment(params: {
        owner: string;
        repo: string;
        pull_number: number;
        comment_id: number;
        body: string;
      }): Promise<unknown>;
    };
    issues: {
      createComment(params: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
    };
  };
};

/** Callers select and authorize the thread; this helper only sends the reply. */
export async function replyToPullRequestComment({
  owner,
  repo,
  prNumber,
  commentId,
  body,
  type,
  octokit,
}: {
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  body: string;
  type: "issue" | "review";
  octokit: ReplyClient;
}): Promise<void> {
  const safeBody = redactCredentials(body);
  try {
    await retryWithBackoff(
      async () => {
        if (type === "review") {
          await octokit.rest.pulls.createReplyForReviewComment({
            owner,
            repo,
            pull_number: prNumber,
            comment_id: commentId,
            body: safeBody,
          });
        } else {
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: prNumber,
            body: safeBody,
          });
        }
      },
      {
        initialDelayMs: 1000,
        maxDelayMs: 4000,
        // A rejected 429 is safe to repeat. An unknown POST result is not.
        shouldRetry: (error) => "status" in error && error.status === 429,
      },
    );
  } catch (error) {
    throw new Error(
      redactCredentials(error instanceof Error ? error.message : String(error)),
    );
  }
}
