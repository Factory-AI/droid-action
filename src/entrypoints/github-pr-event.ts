#!/usr/bin/env bun

/**
 * Writes a pull_request event for PR_NUMBER to GITHUB_EVENT_PATH, built from
 * the GitHub API, so github/run-review.sh can run the Actions entrypoints
 * outside GitHub Actions. Outputs the PR's current head commit.
 *
 * Right after a push, the API can still report the PR's previous head. With
 * PR_HEAD_WAIT_SECONDS set, the PR is read again for up to that long, until
 * its head is PR_HEAD_SHA or has moved past it.
 */

import * as core from "@actions/core";
import { writeFile } from "fs/promises";
import { createOctokit } from "../github/api/client";
import { retryWithBackoff } from "../utils/retry";
import { redactCredentials } from "../utils/redact-credentials";

async function run() {
  const [owner = "", repo = ""] = process.env.GITHUB_REPOSITORY!.split("/");
  const pull_number = Number(process.env.PR_NUMBER);
  const octokit = createOctokit(process.env.GITHUB_TOKEN!);
  const read = async () =>
    (
      await retryWithBackoff(() =>
        octokit.rest.pulls.get({ owner, repo, pull_number }),
      )
    ).data;
  // A head that moved past `expected` compares as ahead of it. GitHub not
  // knowing `expected` yet is lag too.
  const movedPast = async (expected: string, head: string) => {
    try {
      const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${expected}...${head}`,
        per_page: 1,
      });
      return data.status === "ahead";
    } catch {
      return false;
    }
  };

  let pr = await read();
  const expected = process.env.PR_HEAD_SHA;
  const deadline =
    Date.now() + Number(process.env.PR_HEAD_WAIT_SECONDS || 0) * 1000;
  let delayMs = 1000;
  while (
    expected &&
    pr.head.sha !== expected &&
    Date.now() < deadline &&
    !(await movedPast(expected, pr.head.sha))
  ) {
    console.log(
      `GitHub reports PR #${pull_number} at ${pr.head.sha}, not yet ${expected}; reading it again.`,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(delayMs, deadline - Date.now())),
    );
    delayMs = Math.min(delayMs * 2, 8000);
    pr = await read();
  }
  await writeFile(
    process.env.GITHUB_EVENT_PATH!,
    JSON.stringify({ action: process.env.PR_ACTION, pull_request: pr }),
  );
  core.setOutput("head_sha", pr.head.sha);
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(
      `github-pr-event failed for ${process.env.GITHUB_REPOSITORY}#${process.env.PR_NUMBER}: ${redactCredentials(error instanceof Error ? error.message : String(error))}`,
    );
    process.exit(1);
  });
}
