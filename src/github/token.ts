#!/usr/bin/env bun

import * as core from "@actions/core";
import { retryWithBackoff } from "../utils/retry";

async function getOidcToken(): Promise<string> {
  try {
    const oidcToken = await core.getIDToken("droid-github-action");
    return oidcToken;
  } catch (error) {
    console.error("Failed to get OIDC token:", error);
    throw new Error(
      "Could not fetch an OIDC token. Did you remember to add `id-token: write` to your workflow permissions?",
    );
  }
}

async function exchangeForAppToken(oidcToken: string): Promise<string> {
  const response = await fetch(
    "https://app.factory.ai/api/github/token-exchange",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
      },
    },
  );

  if (!response.ok) {
    // Try to parse the response as JSON, but handle cases where it might fail
    let responseJson: any;
    try {
      responseJson = await response.json();
    } catch (e) {
      // If JSON parsing fails, throw a generic error
      console.error(
        `App token exchange failed: ${response.status} ${response.statusText} - Could not parse response`,
      );
      throw new Error(`Token exchange failed with status ${response.status}`);
    }

    // Handle the simplified flat error response format
    const errorCode = responseJson.error || `http_${response.status}`;
    const errorMessage = responseJson.message || responseJson.detail || responseJson.error || "Unknown error";
    const specificErrorCode = responseJson.error_code;
    const repository = responseJson.repository;

    // Check for specific error codes that should skip the action
    if (errorCode === "workflow_validation_failed" || 
        specificErrorCode === "workflow_not_found_on_default_branch") {
      core.warning(`Skipping action due to workflow validation: ${errorMessage}`);
      console.log(
        "Action skipped due to workflow validation error. This is expected when adding Droid workflows to new repositories or on PRs with workflow changes. If you're seeing this, your workflow will begin working once you merge your PR.",
      );
      core.setOutput("skipped_due_to_workflow_validation_mismatch", "true");
      process.exit(0);
    }
    
    // Handle GitHub App not installed error with helpful message
    if (errorCode === "app_not_installed") {
      const repo = repository || "this repository";
      console.error(
        `The Factory GitHub App is not installed for ${repo}. ` +
        `Please install it at: https://github.com/apps/factory-ai`
      );
      throw new Error(errorMessage);
    }
    
    // Handle rate limiting with retry suggestion
    if (errorCode === "rate_limited") {
      console.error(
        `GitHub API rate limit exceeded. Please wait a few minutes and try again.`
      );
      throw new Error(errorMessage);
    }
    
    // Handle OIDC verification errors
    if (errorCode === "oidc_verification_failed") {
      if (specificErrorCode === "token_expired") {
        console.error("OIDC token has expired. The workflow may be taking too long.");
      } else if (specificErrorCode === "audience_mismatch") {
        console.error("OIDC token audience mismatch. This is likely a configuration issue.");
      } else if (specificErrorCode === "invalid_signature") {
        console.error("OIDC token signature verification failed.");
      }
    }

    // Log the error with available context
    console.error(
      `App token exchange failed: ${response.status} ${response.statusText} - ${errorMessage}`,
      errorCode !== errorMessage ? `(Code: ${errorCode})` : "",
      specificErrorCode ? `(Specific: ${specificErrorCode})` : ""
    );
    throw new Error(errorMessage);
  }

  // Parse successful response
  const appTokenData = (await response.json()) as {
    token?: string;
    expires_at?: string;
  };
  
  if (!appTokenData.token) {
    throw new Error("App token not found in response");
  }

  return appTokenData.token;
}

export async function setupGitHubToken(): Promise<string> {
  try {
    // Check if GitHub token was provided as override
    const providedToken = process.env.OVERRIDE_GITHUB_TOKEN;

    if (providedToken) {
      console.log("Using provided GITHUB_TOKEN for authentication");
      core.setOutput("GITHUB_TOKEN", providedToken);
      return providedToken;
    }

    console.log("Requesting OIDC token...");
    const oidcToken = await retryWithBackoff(() => getOidcToken());
    console.log("OIDC token successfully obtained");

    console.log("Exchanging OIDC token for app token...");
    const appToken = await retryWithBackoff(() =>
      exchangeForAppToken(oidcToken),
    );
    console.log("App token successfully obtained");

    console.log("Using GITHUB_TOKEN from OIDC");
    core.setOutput("GITHUB_TOKEN", appToken);
    return appToken;
  } catch (error) {
    // Only set failed if we get here - workflow validation errors will exit(0) before this
    core.setFailed(
      `Failed to setup GitHub token: ${error}\n\nIf you instead wish to use this action with a custom GitHub token or custom GitHub app, provide a \`github_token\` in the \`uses\` section of the app in your workflow yml file.`,
    );
    process.exit(1);
  }
}
