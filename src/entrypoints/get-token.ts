#!/usr/bin/env bun

/**
 * Gets GitHub token via OIDC or uses provided token
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";

async function run() {
  try {
    const overrideToken = process.env.OVERRIDE_GITHUB_TOKEN?.trim();

    let token: string;
    if (overrideToken) {
      console.log("Using provided GitHub token");
      token = overrideToken;
    } else {
      console.log("Requesting OIDC token...");
      token = await setupGitHubToken();
      console.log("GitHub token obtained via OIDC");
    }

    // Set output for next steps
    core.setOutput("github_token", token);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Failed to get GitHub token: ${errorMessage}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
