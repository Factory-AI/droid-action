/**
 * State shared between the Bitbucket review steps. Each step runs as its
 * own process, so every path resolves from the same environment variables.
 * The defaults sit outside the checked-out repository on purpose: a pull
 * request could otherwise commit a symlink at the state path and redirect
 * writes.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { BitbucketTarget } from "./api/client";

export type BitbucketPrepareState = {
  shouldRunReview: boolean;
  reason?: string;
  target: BitbucketTarget | null;
  repoFullName: string | null;
  prId: number | null;
  prWebUrl: string | null;
  trackingCommentId: number | null;
  headSha: string | null;
  /** Target branch head when the diff was fetched (Data Center anchors). */
  baseSha?: string | null;
  /** The server truncated the diff, so the review saw only part of it. */
  diffTruncated?: boolean;
  buildUrl: string | null;
  buildStatus: boolean;
  includeSuggestions: boolean;
  securityReviewEnabled: boolean;
  sourceBranch: string | null;
  targetBranch: string | null;
  promptPath: string | null;
  diffPath: string | null;
  commentsPath: string | null;
  descriptionPath: string | null;
  candidatesPath: string | null;
  validatedPath: string | null;
  resolvedModel: string | null;
  resolvedReasoningEffort: string | null;
  /** Set when Pass 1 left no usable candidates, so Pass 2 never ran. */
  validatorSkippedReason?: string;
};

export const BUILD_STATUS_KEY = "droid-review";
export const BUILD_STATUS_NAME = "Droid code review";

export function promptFilePath(): string {
  return process.env.DROID_PROMPT_FILE || "/tmp/droid-prompts/droid-prompt.txt";
}

export function promptsDir(): string {
  return path.dirname(promptFilePath());
}

export function stateFilePath(): string {
  return (
    process.env.DROID_STATE_FILE || path.join(promptsDir(), ".droid-state.json")
  );
}

export function candidatesFilePath(): string {
  return (
    process.env.REVIEW_CANDIDATES_PATH ||
    path.join(promptsDir(), "review_candidates.json")
  );
}

export function validatedFilePath(): string {
  return (
    process.env.REVIEW_VALIDATED_PATH ||
    path.join(promptsDir(), "review_validated.json")
  );
}

export function postResultsFilePath(): string {
  return (
    process.env.REVIEW_POST_RESULTS_PATH ||
    path.join(promptsDir(), "review_post_results.json")
  );
}

export function resolvedEnvShimPath(): string {
  return (
    process.env.DROID_RESOLVED_ENV_FILE ||
    path.join(promptsDir(), "resolved-env.sh")
  );
}

export async function writeState(state: BitbucketPrepareState): Promise<void> {
  const filePath = stateFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
}

/** Null when the file is missing or unreadable. */
export async function readState(): Promise<BitbucketPrepareState | null> {
  const filePath = stateFilePath();
  try {
    return JSON.parse(
      await fs.readFile(filePath, "utf8"),
    ) as BitbucketPrepareState;
  } catch (err) {
    console.warn(
      `Could not read droid state file at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
