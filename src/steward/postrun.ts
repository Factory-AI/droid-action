#!/usr/bin/env bun

/**
 * CI Steward post-run step.
 *
 * Two jobs, both of which used to be missing:
 *
 * 1. Protected paths were only ever a sentence in the prompt, which means they
 *    held exactly as long as the model chose to honour them. The same prompt
 *    carries job log text written by the code under test, so that is not a
 *    control. Anything protected that changed is restored here.
 *
 * 2. The tracking comment is written before Droid starts. When Droid failed,
 *    nothing rewrote it, so the pull request was left reading "CI Steward is
 *    analyzing" forever while a run had already been spent from the budget.
 */

import { $ } from "bun";
import { createOctokit } from "../github/api/client";
import { createLogger } from "../logger";

const log = createLogger("steward/postrun");

export function matchesProtectedPath(
  patterns: string[],
  file: string,
): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
      // `**` spans directory separators; a single `*` stays within a segment.
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, ".*")
      .replace(/\\\?/g, "[^/]");
    return new RegExp(`^${escaped}$`).test(file);
  });
}

export function protectedViolations(
  patterns: string[],
  changedFiles: string[],
): string[] {
  if (patterns.length === 0) return [];
  return changedFiles.filter((file) => matchesProtectedPath(patterns, file));
}

export async function changedFilesSince(
  baseSha: string,
  cwd?: string,
): Promise<string[]> {
  const command = $`git diff --name-only ${baseSha} HEAD`.nothrow();
  const output = await (cwd ? command.cwd(cwd) : command).text();
  return output
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

// Reverting is separated from pushing so the restore can be exercised against
// a real repository in tests without a remote.
export async function revertProtectedPaths(
  baseSha: string,
  violations: string[],
  cwd?: string,
): Promise<void> {
  const at = (command: any) => (cwd ? command.cwd(cwd) : command);
  // Only the offending paths are restored, so a legitimate fix made in the
  // same run survives.
  for (const file of violations) {
    await at($`git checkout ${baseSha} -- ${file}`.nothrow());
  }
  await at($`git add -- ${violations}`.nothrow());
  await at(
    $`git -c user.name=droid -c user.email=droid@factory.ai commit -m ${"revert(ci): restore protected paths modified by CI Steward"}`.nothrow(),
  );
}

async function updateTrackingComment(body: string): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  const commentId = Number(process.env.DROID_COMMENT_ID);
  const [owner, repo] = (process.env.REPOSITORY ?? "").split("/");
  if (!token || !commentId || !owner || !repo) return;
  const marker = process.env.STEWARD_RUN_MARKER ?? "";
  try {
    const octokit = createOctokit(token);
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body: `${body}\n\n${marker}`,
    });
  } catch (error) {
    log.error(`CI Steward could not update its comment: ${error}`);
  }
}

async function main() {
  const baseSha = process.env.STEWARD_BASE_SHA ?? "";
  const patterns = (process.env.STEWARD_PROTECTED_PATHS ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const succeeded = process.env.DROID_CONCLUSION === "success";
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${process.env.REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;

  let violations: string[] = [];
  if (baseSha && patterns.length > 0) {
    violations = protectedViolations(
      patterns,
      await changedFilesSince(baseSha),
    );
  }

  if (violations.length > 0) {
    log.error(
      `CI Steward modified protected paths; reverting:\n${violations.map((file) => `  - ${file}`).join("\n")}`,
    );
    await revertProtectedPaths(baseSha, violations);
    await $`git push`.nothrow();
    await updateTrackingComment(
      `## CI Steward\n\nThis run tried to modify protected paths and the changes were reverted:\n\n${violations.map((file) => `- \`${file}\``).join("\n")}\n\nA human should review [the run](${runUrl}).`,
    );
    process.exit(1);
  }

  if (!succeeded) {
    await updateTrackingComment(
      `## CI Steward\n\nCI Steward did not finish. See [the run](${runUrl}) for details.`,
    );
  }
}

if (import.meta.main) {
  await main();
}
