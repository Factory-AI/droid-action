#!/usr/bin/env bun

/**
 * Create the initial tracking comment when Droid starts working
 * This comment shows the working status and includes a link to the job run
 */

import { appendFileSync } from "fs";
import {
  createJobRunLink,
  createCommentBody,
  prepareDroidTrackingCommentBody,
  appendPrCommentMarker,
  COMBINED_REVIEW_COMMENT_RUN_TYPE,
  readPrCommentRunType,
  type CommentType,
  type PrCommentKind,
} from "./common";
import {
  isPullRequestReviewCommentEvent,
  isPullRequestEvent,
  type ParsedGitHubContext,
} from "../../context";
import type { Octokit } from "@octokit/rest";
import { getPrValidationRunType, type DroidRunType } from "../../../run-type";
import * as core from "@actions/core";
import { DROID_APP_BOT_ID } from "../../bot-identity";
import {
  decodeReviewState,
  hasSummaryMarker,
  SUMMARY_MARKER,
} from "../../../core/review/markers";
import { renderReviewSummary } from "../../../core/review/render";

export async function createInitialComment(
  octokit: Octokit,
  context: ParsedGitHubContext,
  commentType: CommentType = "default",
  runType?: DroidRunType | null,
) {
  const { owner, repo } = context.repository;

  const jobRunLink = createJobRunLink(owner, repo, context.runId);
  const prValidationRunType = getPrValidationRunType(runType);
  const createInitialBody = (kind: PrCommentKind) =>
    createCommentBody(jobRunLink, "", commentType, prValidationRunType, kind);
  let issueCommentBody = createInitialBody("issue-comment");
  const reviewTracking = context.isPR && !!prValidationRunType;
  if (reviewTracking && !isPullRequestReviewCommentEvent(context)) {
    issueCommentBody = appendPrCommentMarker(
      renderReviewSummary({
        state: "in_progress",
        jobUrl: jobRunLink.match(/\((.*)\)/)?.[1],
        depth: process.env.REVIEW_DEPTH || "deep",
      }),
      "issue-comment",
      commentType === "review_and_security"
        ? COMBINED_REVIEW_COMMENT_RUN_TYPE
        : prValidationRunType!,
    );
  }

  try {
    let response;
    let createdCommentKind: PrCommentKind = "issue-comment";

    if (
      (context.inputs.useStickyComment || reviewTracking) &&
      context.isPR &&
      (isPullRequestEvent(context) ||
        (reviewTracking && !isPullRequestReviewCommentEvent(context)))
    ) {
      let existingComment;
      for (let page = 1; !existingComment; page++) {
        const comments = await octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: context.entityNumber,
          per_page: 100,
          page,
        });
        existingComment = comments.data.find((comment) => {
          const idMatch = comment.user?.id === DROID_APP_BOT_ID;
          const configuredBotMatch =
            !!process.env.DROID_BOT_LOGIN &&
            comment.user?.login === process.env.DROID_BOT_LOGIN;
          const markerMatch =
            hasSummaryMarker(comment.body || "") ||
            !!readPrCommentRunType(comment.body || "", "issue-comment");
          return (idMatch || configuredBotMatch) && markerMatch;
        });
        if (comments.data.length < 100) break;
      }
      if (existingComment) {
        if (reviewTracking)
          issueCommentBody = renderReviewSummary({
            state: "in_progress",
            jobUrl: jobRunLink.match(/\((.*)\)/)?.[1],
            previousBody: existingComment.body || "",
            previousHead: decodeReviewState(existingComment.body || "")?.head,
            reviewState:
              decodeReviewState(existingComment.body || "") || undefined,
            depth: process.env.REVIEW_DEPTH || "deep",
          });
        issueCommentBody = prepareDroidTrackingCommentBody(
          issueCommentBody,
          existingComment.body ?? "",
          commentType === "review_and_security"
            ? COMBINED_REVIEW_COMMENT_RUN_TYPE
            : prValidationRunType,
        );
        if (reviewTracking && !hasSummaryMarker(issueCommentBody))
          issueCommentBody = `${SUMMARY_MARKER}\n\n${issueCommentBody}`;
        response = await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existingComment.id,
          body: issueCommentBody,
        });
      } else {
        // Create new comment if no existing one found
        response = await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: context.entityNumber,
          body: issueCommentBody,
        });
      }
    } else if (isPullRequestReviewCommentEvent(context)) {
      // Only use createReplyForReviewComment if it's a PR review comment AND we have a comment_id
      response = await octokit.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: context.entityNumber,
        comment_id: context.payload.comment.id,
        body: createInitialBody("inline-comment"),
      });
      createdCommentKind = "inline-comment";
    } else {
      // For all other cases (issues, issue comments, or missing comment_id)
      response = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: context.entityNumber,
        body: issueCommentBody,
      });
    }

    // Output the comment ID for downstream steps using GITHUB_OUTPUT
    const githubOutput = process.env.GITHUB_OUTPUT!;
    appendFileSync(githubOutput, `droid_comment_id=${response.data.id}\n`);
    core.exportVariable("DROID_PR_COMMENT_KIND", createdCommentKind);
    console.log(`✅ Created initial comment with ID: ${response.data.id}`);
    return response.data;
  } catch (error) {
    console.error("Error in initial comment:", error);

    // Always fall back to regular issue comment if anything fails
    try {
      const response = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: context.entityNumber,
        body: issueCommentBody,
      });

      const githubOutput = process.env.GITHUB_OUTPUT!;
      appendFileSync(githubOutput, `droid_comment_id=${response.data.id}\n`);
      core.exportVariable("DROID_PR_COMMENT_KIND", "issue-comment");
      console.log(`✅ Created fallback comment with ID: ${response.data.id}`);
      return response.data;
    } catch (fallbackError) {
      console.error("Error creating fallback comment:", fallbackError);
      throw fallbackError;
    }
  }
}
