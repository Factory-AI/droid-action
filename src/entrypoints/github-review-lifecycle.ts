#!/usr/bin/env bun
import { createOctokit, type Octokits } from "../github/api/client";
import {
  advanceReviewLifecycle,
  finishReviewLifecycle,
  loadBoundReviewLifecycle,
  type ReviewSessionIdentity,
} from "../github/operations/review-lifecycle";
import { redactCredentials } from "../utils/redact-credentials";
import { readFile } from "fs/promises";
import { join } from "path";
import { parseValidatedReview } from "../core/review/validated/parse";

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
      process.env.DROID_VALIDATOR_ERROR_MESSAGE ||
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
  const name = {
    gathered: "Generating candidates",
    candidates: "Generating candidates",
    validated: "Validating candidates",
    posted: "Posting review",
  }[phase];
  if (!name) throw new Error(`Unknown review lifecycle phase: ${phase}`);
  let completedName: string | undefined;
  try {
    if (phase === "validated") {
      const candidateFile =
        process.env.REVIEW_CANDIDATES_PATH ||
        join(
          process.env.RUNNER_TEMP || "/tmp",
          "droid-prompts",
          "review_candidates.json",
        );
      const candidates: unknown = JSON.parse(
        await readFile(candidateFile, "utf8"),
      );
      if (
        candidates &&
        typeof candidates === "object" &&
        "candidates" in candidates &&
        Array.isArray(candidates.candidates)
      )
        completedName = `Generated ${candidates.candidates.length} candidates`;
    } else if (phase === "posted") {
      const validatedFile =
        process.env.REVIEW_VALIDATED_PATH ||
        join(
          process.env.RUNNER_TEMP || "/tmp",
          "droid-prompts",
          "review_validated.json",
        );
      const review = parseValidatedReview(
        await readFile(validatedFile, "utf8"),
      );
      completedName = `Validated candidates, kept ${review.approvedCount}`;
    }
  } catch {
    /* Counts are optional progress metadata; posting validates the actual file. */
  }
  await advanceReviewLifecycle({
    octokit,
    run: lifecycle,
    name,
    completedName,
  });
}
if (import.meta.main)
  run().catch((error) => {
    console.warn(
      redactCredentials(error instanceof Error ? error.message : String(error)),
    );
  });
