#!/usr/bin/env bun

/**
 * Prepare the Droid action by checking trigger conditions, verifying human actor,
 * and creating the initial tracking comment
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { shouldTriggerTag } from "../tag";
import { prepare } from "../prepare";
import { collectActionInputsPresence } from "./collect-inputs";

async function run() {
  try {
    collectActionInputsPresence();

    // Parse GitHub context first to enable mode detection
    const context = parseGitHubContext();

    // Setup GitHub token
    const githubToken = await setupGitHubToken();
    const octokit = createOctokit(githubToken);

    // Step 3: Check write permissions (only for entity contexts)
    if (isEntityContext(context)) {
      // Check if github_token was provided as input (not from app)
      const githubTokenProvided = !!process.env.OVERRIDE_GITHUB_TOKEN;
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        githubTokenProvided,
      );
      if (!hasWritePermissions) {
        throw new Error(
          "Actor does not have write permissions to the repository",
        );
      }
    }

    // Check trigger conditions
    const containsTrigger = shouldTriggerTag(context);

    console.log(`Trigger result: ${containsTrigger}`);

    // Set output for action.yml to check
    core.setOutput("contains_trigger", containsTrigger.toString());

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      // Still set github_token output even when skipping
      core.setOutput("github_token", githubToken);
      return;
    }

    // Step 5: Use the new modular prepare function
    const result = await prepare({
      context,
      octokit,
      githubToken,
    });

    // MCP config is handled by individual modes (tag/agent) and included in their droid_args output

    // Expose the GitHub token (Droid App token) as an output
    core.setOutput("github_token", githubToken);

    // Pass MCP tool config downstream for registration
    if (result?.mcpTools) {
      core.setOutput("mcp_tools", result.mcpTools);
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Prepare step failed with error: ${errorMessage}`);
    // Also output the clean error message for the action to capture
    core.setOutput("prepare_error", errorMessage);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
