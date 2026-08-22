#!/usr/bin/env bun

import * as core from "@actions/core";
import { readFile } from "fs/promises";
import { setupGitHubToken } from "../github/token";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { prepareReviewValidatorMode } from "../tag/commands/review-validator";

async function run() {
  try {
    const context = parseGitHubContext();

    if (!isEntityContext(context) || !context.isPR) {
      throw new Error("prepare-validator requires a pull request context");
    }

    // Validate that Pass 1 produced a valid candidates JSON file.
    // If the file is missing or invalid, skip Pass 2 gracefully rather than
    // failing the entire pipeline. This prevents the ~2% of reviews where
    // Pass 1 had a transient issue from counting as full failures.
    const candidatesPath = process.env.REVIEW_CANDIDATES_PATH || "";
    if (candidatesPath) {
      let validationError: string | null = null;

      try {
        const content = await readFile(candidatesPath, "utf8");
        const parsed = JSON.parse(content);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !Array.isArray(parsed.comments)
        ) {
          throw new Error("Missing or invalid 'comments' array in candidates");
        }
        console.log(
          `Pass 1 candidates validated: ${parsed.comments.length} comments found`,
        );
      } catch (firstError) {
        const firstMessage =
          firstError instanceof Error ? firstError.message : String(firstError);
        console.warn(
          `Pass 1 candidates validation failed on first attempt: ${firstMessage}`,
        );

        // Retry once after a short delay in case of partially-flushed write
        await new Promise((resolve) => setTimeout(resolve, 500));

        try {
          const content = await readFile(candidatesPath, "utf8");
          const parsed = JSON.parse(content);

          if (!parsed || typeof parsed !== "object") {
            throw new Error("Candidates file is not a valid JSON object");
          }

          // Try to repair: if comments array is malformed but we can extract some valid entries
          if (!Array.isArray(parsed.comments)) {
            throw new Error(
              "Missing or invalid 'comments' array in candidates",
            );
          }

          // Filter out any malformed comments (keep only valid objects)
          const validComments = parsed.comments.filter(
            (c: any) => c && typeof c === "object",
          );

          if (validComments.length === 0) {
            throw new Error("No valid comments found in candidates array");
          }

          console.log(
            `Pass 1 candidates validated on retry: ${validComments.length} valid comments found`,
          );
        } catch (retryError) {
          validationError =
            retryError instanceof Error
              ? retryError.message
              : String(retryError);
          console.error(
            `Pass 1 candidates JSON is invalid or missing after retry: ${validationError}`,
          );
          console.error(
            "Review cannot proceed without valid Pass 1 output - this indicates a Pass 1 failure",
          );

          // Make this loud: it's a lost review, not a graceful skip
          core.warning(
            `Pass 1 candidates validation failed - review was not completed. Reason: ${validationError}`,
          );
          core.setOutput("validator_should_run", "false");
          core.setOutput("validation_skip_reason", validationError);
          core.setOutput("review_outcome", "skipped_invalid_candidates");
          return;
        }
      }
    }

    const githubToken = await setupGitHubToken();
    const octokit = createOctokit(githubToken);

    const trackingCommentId = Number(process.env.DROID_COMMENT_ID);
    if (!trackingCommentId || Number.isNaN(trackingCommentId)) {
      throw new Error("DROID_COMMENT_ID is required for validator run");
    }

    const result = await prepareReviewValidatorMode({
      context,
      octokit,
      githubToken,
      trackingCommentId,
    });

    core.setOutput("github_token", githubToken);
    core.setOutput("validator_should_run", "true");
    if (result?.mcpTools) core.setOutput("mcp_tools", result.mcpTools);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Prepare validator step failed with error: ${errorMessage}`);
    core.setOutput("prepare_error", errorMessage);
    process.exit(1);
  }
}

export default run;

if (import.meta.main) {
  run();
}
