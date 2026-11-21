#!/usr/bin/env bun

/**
 * Prepares a review for the standalone review and security actions: decides
 * whether one runs, opens its lifecycle, and leaves the worker's input.
 */

import * as core from "@actions/core";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { fetchPRBranchData } from "../github/data/pr-fetcher";
import { prepareReviewInput } from "../github/data/review-input";
import { DroidRunType, setDroidRunType } from "../run-type";
import { initializeReviewConfig } from "../prepare/review-config";
import { freezeReviewRuntime } from "../prepare/review-runtime";
import { automaticReviewSkipReason } from "../core/review/config";
import { extractCommandFromContext } from "../github/utils/command-parser";
import { isManualReviewRequest } from "../github/utils/review-intent";
import { prepareReviewLifecycle } from "../github/operations/review-lifecycle";

export async function run() {
  try {
    const githubToken = process.env.GITHUB_TOKEN!;
    const reviewType = process.env.REVIEW_TYPE || "code";
    const runType =
      reviewType === "security"
        ? DroidRunType.SecurityReview
        : DroidRunType.Review;
    setDroidRunType(runType);
    let commentId = parseInt(process.env.DROID_COMMENT_ID || "0");

    if (!commentId) {
      throw new Error("DROID_COMMENT_ID is required and must be non-zero");
    }

    const context = parseGitHubContext();

    if (!isEntityContext(context)) {
      throw new Error("Review requires entity context (PR or issue)");
    }

    if (!context.isPR) {
      throw new Error("Review is only supported on pull requests");
    }

    const octokit = createOctokit(githubToken);
    await initializeReviewConfig(context, octokit);
    await freezeReviewRuntime();

    const prData = await fetchPRBranchData({
      octokits: octokit,
      repository: context.repository,
      prNumber: context.entityNumber,
    });
    core.setOutput("review_head_sha", prData.headRefOid);
    const command = extractCommandFromContext(context);
    const manualReview = isManualReviewRequest(
      context,
      reviewType === "security" ? "security" : "code",
    );
    const config = context.inputs.reviewConfig!;
    const skipReason = automaticReviewSkipReason({
      config,
      draft:
        "pull_request" in context.payload &&
        !!context.payload.pull_request.draft,
      eventAction: context.eventAction,
      manual: manualReview,
    });
    const lifecycle = await prepareReviewLifecycle({
      octokit,
      context,
      headSha: prData.headRefOid,
      baseSha: process.env.REVIEW_BASE_SHA,
      trackingCommentId: commentId,
      securityOnly: reviewType === "security",
      full:
        manualReview &&
        (reviewType === "security" || command?.fullReview === true),
      skipReason: skipReason ?? undefined,
    });
    commentId = lifecycle.commentId;
    core.setOutput("droid_comment_id", String(commentId));
    if (lifecycle.skipReason) {
      core.setOutput("review_skipped", "true");
      return;
    }

    const prepared = await prepareReviewInput({
      octokit,
      githubToken,
      run: lifecycle.run,
      pullRequest: prData,
      focus: manualReview ? command?.focus : undefined,
    });
    if (prepared.skipReason) {
      core.setOutput("review_skipped", "true");
      return;
    }
    console.log(`Prepared the ${reviewType} review`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Review preparation failed: ${errorMessage}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
