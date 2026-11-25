#!/usr/bin/env bun

/**
 * Writes a pull_request event for PR_NUMBER to GITHUB_EVENT_PATH, built from
 * the GitHub API, so github/run-review.sh can run the Actions entrypoints
 * outside GitHub Actions. Outputs the PR's current head commit and author.
 */

import * as core from "@actions/core";
import { writeFile } from "fs/promises";
import { createOctokit } from "../github/api/client";
import { retryWithBackoff } from "../utils/retry";
import { redactCredentials } from "../utils/redact-credentials";

async function run() {
  const [owner = "", repo = ""] = process.env.GITHUB_REPOSITORY!.split("/");
  const octokit = createOctokit(process.env.GITHUB_TOKEN!);
  const { data: pr } = await retryWithBackoff(() =>
    octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: Number(process.env.PR_NUMBER),
    }),
  );
  await writeFile(
    process.env.GITHUB_EVENT_PATH!,
    JSON.stringify({
      action: process.env.PR_ACTION,
      number: pr.number,
      pull_request: pr,
      repository: pr.base.repo,
      sender: pr.user,
    }),
  );
  core.setOutput("head_sha", pr.head.sha);
  core.setOutput("author", pr.user.login);
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(
      `github-pr-event failed for ${process.env.GITHUB_REPOSITORY}#${process.env.PR_NUMBER}: ${redactCredentials(error instanceof Error ? error.message : String(error))}`,
    );
    process.exit(1);
  });
}
