import type { Octokits } from "../../api/client";
import { fetchDroidComment } from "./fetch-droid-comment";
import {
  prepareDroidTrackingCommentBody,
  type PrCommentRunType,
} from "./common";
import {
  updateDroidComment,
  type UpdateDroidCommentParams,
} from "./update-droid-comment";

export async function updateDroidTrackingComment(
  octokit: Octokits,
  params: UpdateDroidCommentParams & { runType?: PrCommentRunType },
) {
  // A failed read must not fall through to a write that could erase the
  // shared comment's existing classification.
  const { comment, isPRReviewComment } = await fetchDroidComment(octokit, {
    owner: params.owner,
    repo: params.repo,
    commentId: params.commentId,
    isPullRequestReviewCommentEvent: params.isPullRequestReviewComment,
  });
  const kind = isPRReviewComment ? "inline-comment" : "issue-comment";
  return updateDroidComment(octokit.rest, {
    ...params,
    body: prepareDroidTrackingCommentBody(
      params.body,
      comment.body ?? "",
      params.runType,
      kind,
    ),
    isPullRequestReviewComment: isPRReviewComment,
  });
}
