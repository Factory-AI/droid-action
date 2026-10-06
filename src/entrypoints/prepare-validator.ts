#!/usr/bin/env bun

import * as core from "@actions/core";
import { readFile } from "fs/promises";
import { setupGitHubToken } from "../github/token";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { prepareReviewValidatorMode } from "../tag/commands/review-validator";
import { DroidRunType, parseDroidRunType, setDroidRunType } from "../run-type";

function classifyPass1Failure(
  error: unknown,
  content: string | undefined,
): string {
  const message = error instanceof Error ? error.message : String(error);

  // File was never created
  if (message.includes("ENOENT") || message.includes("no such file")) {
    return "file_missing";
  }

  // JSON parsing failed
  if (message.includes("JSON") || error instanceof SyntaxError) {
    // Check if content suggests a Task tool failure
    if (
      content &&
      (content.includes("Error spawning") ||
        content.includes("Task tool failed") ||
        content.includes("Failed to spawn") ||
        content.includes("subagent"))
    ) {
      return "task_tool_failure";
    }
    return "json_parse_error";
  }

  // Missing expected structure
  if (message.includes("comments")) {
    return "invalid_structure";
  }

  return "unknown_failure";
}

async function run() {
  try {
    const context = parseGitHubContext();

    if (!isEntityContext(context) || !context.isPR) {
      throw new Error("prepare-validator requires a pull request context");
    }
    const runType =
      parseDroidRunType(process.env.DROID_EXEC_RUN_TYPE) ?? DroidRunType.Review;
    setDroidRunType(runType);

    // Validate that Pass 1 produced a valid candidates JSON file.
    // If the file is missing or invalid, skip Pass 2 gracefully rather than
    // failing the entire pipeline. This prevents the ~2% of reviews where
    // Pass 1 had a transient issue from counting as full failures.
    const candidatesPath = process.env.REVIEW_CANDIDATES_PATH || "";
    if (candidatesPath) {
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
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        let content: string | undefined;
        try {
          content = await readFile(candidatesPath, "utf8");
        } catch {
          // File doesn't exist or can't be read
        }
        const failureReason = classifyPass1Failure(e, content);

        console.error(
          `Pass 1 candidates JSON is invalid or missing: ${message}`,
        );
        console.error(
          "Skipping Pass 2 (validator) to avoid a full pipeline failure",
        );

        // Add structured failure reasons for better diagnostics
        core.setOutput("pass1_failure_reason", failureReason);
        core.setOutput("validator_should_run", "false");

        if (failureReason === "task_tool_failure") {
          core.error(
            "Task tool failed to spawn subagents - this may indicate transient capacity issues or network failures",
          );
        } else if (failureReason === "json_parse_error") {
          core.error(
            "Subagent returned malformed JSON - this may indicate a crashed subagent or incomplete output",
          );
        } else if (failureReason === "file_missing") {
          core.error(
            "Pass 1 candidates file was not created - this indicates Pass 1 did not complete",
          );
        }

        core.notice(
          `Pass 1 candidates validation failed (${failureReason}) - skipping validator pass`,
        );
        return;
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
      runType,
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
