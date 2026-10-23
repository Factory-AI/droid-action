#!/usr/bin/env bun

/**
 * Revokes the GitHub App token the action minted, so a copy of it stops
 * working when the job ends instead of an hour after issue. Never fails the
 * job: a token that cannot be revoked still expires on its own.
 */

import * as core from "@actions/core";
import { revokeGitHubAppToken } from "../github/token";

export async function run(): Promise<void> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    console.log("No GitHub App token to revoke.");
    return;
  }

  // A provided github_token belongs to the caller, who may still need it.
  if (process.env.OVERRIDE_GITHUB_TOKEN?.trim()) {
    console.log(
      "Using a provided github_token, so there is nothing to revoke.",
    );
    return;
  }

  try {
    await revokeGitHubAppToken(token);
    console.log("Revoked the GitHub App token.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.warning(
      `Could not revoke the GitHub App token; it stays valid until it expires: ${message}`,
    );
  }
}

if (import.meta.main) {
  run();
}
