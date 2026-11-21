import * as core from "@actions/core";
import type { GitHubContext } from "../../github/context";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { prepareReviewInput } from "../../github/data/review-input";
import { isEntityContext } from "../../github/context";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";
import { assertDroidRunType, DroidRunType } from "../../run-type";
import { prepareReviewLifecycle } from "../../github/operations/review-lifecycle";
import {
  automaticReviewSkipReason,
  reviewConfigFromEnvironment,
} from "../../core/review/config";
import { isManualReviewRequest } from "../../github/utils/review-intent";

type ReviewCommandOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId?: number;
  runType?: DroidRunType | null;
  fullReview?: boolean;
  focus?: string;
};

export async function prepareReviewMode({
  context,
  octokit,
  githubToken,
  trackingCommentId,
  runType = DroidRunType.Review,
  fullReview,
  focus,
}: ReviewCommandOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("Review command requires an entity event context");
  }

  if (!context.isPR) {
    throw new Error("Review command is only supported on pull requests");
  }
  assertDroidRunType(runType, [
    DroidRunType.Default,
    DroidRunType.Review,
    null,
  ]);

  const prData = await fetchPRBranchData({
    octokits: octokit,
    repository: context.repository,
    prNumber: context.entityNumber,
  });

  const branchInfo = {
    baseBranch: prData.baseRefName,
    droidBranch: undefined,
    currentBranch: prData.headRefName,
  };
  const config = context.inputs.reviewConfig ?? reviewConfigFromEnvironment();
  const draft =
    "pull_request" in context.payload && context.payload.pull_request.draft;
  const automaticSkip = automaticReviewSkipReason({
    config,
    draft: !!draft,
    eventAction: context.eventAction,
    manual: isManualReviewRequest(context),
  });
  const lifecycle = await prepareReviewLifecycle({
    octokit,
    context,
    headSha: prData.headRefOid,
    trackingCommentId,
    full: fullReview,
    skipReason: automaticSkip ?? undefined,
  });
  const commentId = lifecycle.commentId;
  const skipReason =
    lifecycle.skipReason ??
    (
      await prepareReviewInput({
        octokit,
        githubToken,
        run: lifecycle.run,
        pullRequest: prData,
        focus,
      })
    ).skipReason;
  if (skipReason) {
    core.setOutput("run_code_review", "false");
    core.setOutput("run_security_review", "false");
    core.setOutput("steward_skipped", "true");
    return {
      skipped: true,
      reason: skipReason,
      commentId,
      branchInfo,
      mcpTools: "",
    };
  }
  core.setOutput("review_pr_number", context.entityNumber.toString());
  core.setOutput("droid_comment_id", commentId.toString());

  return { commentId, branchInfo, mcpTools: "" };
}
