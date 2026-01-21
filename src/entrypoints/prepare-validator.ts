#!/usr/bin/env bun

import * as core from "@actions/core";
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

    // This entrypoint only makes sense when the workflow input is enabled.
    if ((process.env.REVIEW_USE_VALIDATOR ?? "").trim() !== "true") {
      throw new Error("reviewUseValidator must be true to run prepare-validator");
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
