#!/usr/bin/env bun

import { createOctokit } from "../github/api/client";
import * as fs from "fs/promises";
import {
  updateCommentBody,
  type CommentUpdateInput,
} from "../github/operations/comment-logic";
import {
  parseGitHubContext,
  isPullRequestReviewCommentEvent,
  isEntityContext,
} from "../github/context";
import { GITHUB_SERVER_URL } from "../github/api/config";

import { updateDroidComment } from "../github/operations/comments/update-droid-comment";

async function run() {
  try {
    const commentId = parseInt(process.env.DROID_COMMENT_ID!);
    const githubToken = process.env.GITHUB_TOKEN!;
    const triggerUsername = process.env.TRIGGER_USERNAME;

    const context = parseGitHubContext();

    // This script is only called for entity-based events
    if (!isEntityContext(context)) {
      throw new Error("update-comment-link requires an entity context");
    }

    const { owner, repo } = context.repository;

    const octokit = createOctokit(githubToken);

    const serverUrl = GITHUB_SERVER_URL;
    const jobUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;

    let comment;
    let isPRReviewComment = false;

    try {
      // GitHub has separate ID namespaces for review comments and issue comments
      // We need to use the correct API based on the event type
      if (isPullRequestReviewCommentEvent(context)) {
        // For PR review comments, use the pulls API
        console.log(`Fetching PR review comment ${commentId}`);
        const { data: prComment } = await octokit.rest.pulls.getReviewComment({
          owner,
          repo,
          comment_id: commentId,
        });
        comment = prComment;
        isPRReviewComment = true;
        console.log("Successfully fetched as PR review comment");
      }

      // For all other event types, use the issues API
      if (!comment) {
        console.log(`Fetching issue comment ${commentId}`);
        const { data: issueComment } = await octokit.rest.issues.getComment({
          owner,
          repo,
          comment_id: commentId,
        });
        comment = issueComment;
        isPRReviewComment = false;
        console.log("Successfully fetched as issue comment");
      }
    } catch (finalError) {
      // If all attempts fail, try to determine more information about the comment
      console.error("Failed to fetch comment. Debug info:");
      console.error(`Comment ID: ${commentId}`);
      console.error(`Event name: ${context.eventName}`);
      console.error(`Entity number: ${context.entityNumber}`);
      console.error(`Repository: ${context.repository.full_name}`);

      // Try to get the PR info to understand the comment structure
      try {
        const { data: pr } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: context.entityNumber,
        });
        console.log(`PR state: ${pr.state}`);
        console.log(`PR comments count: ${pr.comments}`);
        console.log(`PR review comments count: ${pr.review_comments}`);
      } catch {
        console.error("Could not fetch PR info for debugging");
      }

      throw finalError;
    }

    const currentBody = comment.body ?? "";

    const branchLink = "";
    const prLink = "";

    // Check if action failed and read output file for execution details
    let executionDetails: {
      cost_usd?: number;
      duration_ms?: number;
      duration_api_ms?: number;
    } | null = null;
    let actionFailed = false;
    let errorDetails: string | undefined;

    // First check if prepare step failed
    const prepareSuccess = process.env.PREPARE_SUCCESS !== "false";
    const prepareError = process.env.PREPARE_ERROR;

    if (!prepareSuccess && prepareError) {
      actionFailed = true;
      errorDetails = prepareError;
    } else {
      // Check for existence of output file and parse it if available
      try {
        const outputFile = process.env.OUTPUT_FILE;
        if (outputFile) {
          const fileContent = await fs.readFile(outputFile, "utf8");
          const outputData = JSON.parse(fileContent);

          // Output file is an array, get the last element which contains execution details
          if (Array.isArray(outputData) && outputData.length > 0) {
            const lastElement = outputData[outputData.length - 1];
            if (
              lastElement.type === "result" &&
              "cost_usd" in lastElement &&
              "duration_ms" in lastElement
            ) {
              executionDetails = {
                cost_usd: lastElement.cost_usd,
                duration_ms: lastElement.duration_ms,
                duration_api_ms: lastElement.duration_api_ms,
              };
            }
          }
        }

        // Check if the Droid action failed
        const droidSuccess = process.env.DROID_SUCCESS !== "false";
        actionFailed = !droidSuccess;
      } catch (error) {
        console.error("Error reading output file:", error);
        // If we can't read the file, check for any failure markers
        actionFailed = process.env.DROID_SUCCESS === "false";
      }
    }

    // Prepare input for updateCommentBody function
    const commentInput: CommentUpdateInput = {
      currentBody,
      actionFailed,
      executionDetails,
      jobUrl,
      branchLink,
      prLink,
      branchName: undefined,
      triggerUsername,
      errorDetails,
    };

    const updatedBody = updateCommentBody(commentInput);

    try {
      await updateDroidComment(octokit.rest, {
        owner,
        repo,
        commentId,
        body: updatedBody,
        isPullRequestReviewComment: isPRReviewComment,
      });
      console.log(
        `✅ Updated ${isPRReviewComment ? "PR review" : "issue"} comment ${commentId} with job link`,
      );
    } catch (updateError) {
      console.error(
        `Failed to update ${isPRReviewComment ? "PR review" : "issue"} comment:`,
        updateError,
      );
      throw updateError;
    }

    process.exit(0);
  } catch (error) {
    console.error("Error updating comment with job link:", error);
    process.exit(1);
  }
}

run();
