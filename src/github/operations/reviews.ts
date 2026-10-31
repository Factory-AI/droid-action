import { appendPrCommentMarker } from "./comments/common";
import type { PrValidationRunType } from "../../run-type";
import { normalizeFinding } from "../../core/review/validated/finding";
import {
  renderInlineComment,
  renderReviewBody,
} from "../../core/review/render";
import { redactCredentials } from "../../utils/redact-credentials";

export type GitHubReviewCommentPayload = {
  path: string;
  body: string;
  line?: number;
  side?: string;
  start_line?: number;
  start_side?: string;
  position?: number;
};

export type GitHubReviewCreateClient = {
  rest: {
    pulls: {
      createReview: (...args: any[]) => Promise<{ data: { id?: number } }>;
      listCommentsForReview?: (...args: any[]) => Promise<{
        data: Array<{ id: number; body?: string; html_url?: string }>;
      }>;
    };
  };
};

/**
 * Creates one COMMENT review and returns its GitHub review ID.
 *
 * `commitId` pins the review to the commit the anchors were computed
 * against. Without it GitHub resolves `line`/`side` against the PR's
 * current head, so a push that lands between diff generation and posting
 * makes the anchors point at different code or fail the whole review.
 */
export async function createGitHubCommentReview(options: {
  client: GitHubReviewCreateClient;
  owner: string;
  repo: string;
  prNumber: number;
  body?: string;
  comments?: GitHubReviewCommentPayload[];
  commitId?: string | null;
  runType?: PrValidationRunType;
  rendered?: boolean;
}): Promise<number | undefined> {
  const { client, owner, repo, prNumber, body, comments, commitId, runType } =
    options;
  if (!comments?.length) return undefined;
  const richComments = comments.map((comment) => ({
    ...comment,
    body: options.rendered
      ? redactCredentials(comment.body)
      : renderInlineComment(normalizeFinding(comment), {
          head: commitId ?? undefined,
        }),
  }));
  const preparedComments = runType
    ? richComments.map((comment) => ({
        ...comment,
        body: appendPrCommentMarker(comment.body, "inline-comment", runType),
      }))
    : richComments;
  const response = await client.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    event: "COMMENT",
    ...(commitId ? { commit_id: commitId } : {}),
    body:
      options.rendered && body
        ? redactCredentials(body)
        : renderReviewBody({
            state: "findings",
            head: commitId ?? undefined,
            findings: comments.map((comment) => normalizeFinding(comment)),
          }),
    ...(preparedComments && preparedComments.length > 0
      ? { comments: preparedComments }
      : {}),
  });
  return response.data.id;
}
