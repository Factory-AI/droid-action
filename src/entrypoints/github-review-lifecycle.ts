#!/usr/bin/env bun
import { createOctokit, type Octokits } from "../github/api/client";
import {
  advanceReviewLifecycle,
  finishReviewLifecycle,
  loadBoundReviewLifecycle,
  type ReviewSessionIdentity,
} from "../github/operations/review-lifecycle";
import { redactCredentials } from "../utils/redact-credentials";

export async function run(
  options: { octokit?: Octokits; reviewSession?: ReviewSessionIdentity } = {},
): Promise<void> {
  if (!process.env.GITHUB_TOKEN && !options.octokit) return;
  if (
    (process.env.REVIEW_POSTED === "true" ||
      process.env.REVIEW_SKIPPED === "true") &&
    process.env.DROID_SUCCESS !== "false"
  )
    return;
  const octokit = options.octokit ?? createOctokit(process.env.GITHUB_TOKEN!);
  const lifecycle = await loadBoundReviewLifecycle(
    octokit,
    options.reviewSession,
  );
  if (!lifecycle || lifecycle.completed) return;
  const phase = process.env.REVIEW_PHASE || "finalize";
  if (phase === "finalize") {
    const error =
      process.env.DROID_POST_ERROR_MESSAGE ||
      process.env.DROID_ERROR_MESSAGE ||
      process.env.PREPARE_ERROR;
    await finishReviewLifecycle({
      octokit,
      run: lifecycle,
      error:
        process.env.DROID_SUCCESS === "false"
          ? error ||
            "The review did not complete. Check the job log and comment @droid review to retry."
          : !lifecycle.renderInput
            ? "The review stopped before validated results were posted."
            : undefined,
    });
    return;
  }
  if (phase !== "reviewing")
    throw new Error(`Unknown review lifecycle phase: ${phase}`);
  await advanceReviewLifecycle({ octokit, run: lifecycle, name: "Reviewing" });
}
if (import.meta.main)
  run().catch((error) => {
    console.warn(
      redactCredentials(error instanceof Error ? error.message : String(error)),
    );
  });
