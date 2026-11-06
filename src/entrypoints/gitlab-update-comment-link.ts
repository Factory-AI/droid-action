#!/usr/bin/env bun

/**
 * Post-step for the GitLab CI/CD Component: edit the sticky tracking note
 * to reflect the final outcome (success/failure) and link to the pipeline.
 *
 * The review summary and the posted/failed counts come from the
 * `review_post_results.json` that `gitlab-post-review` writes, since on
 * GitLab the agent never touches the note itself.
 *
 * Inputs (env):
 *   GITLAB_TOKEN           - access token (api scope)
 *   CI_PROJECT_ID / CI_MERGE_REQUEST_IID - the only source of the target MR
 *   DROID_STATE_FILE       - JSON state written by gitlab-prepare
 *   DROID_SUCCESS          - "true" | "false" set by the CI job
 *   DROID_ERROR_FILE       - error file to embed on failure (default
 *                            /tmp/droid-error.txt); read only if it is a
 *                            regular file, capped and redacted
 *   AUTOMATIC_SECURITY_REVIEW - "true" to render the security badge
 *   TRIGGER_USERNAME       - optional, e.g. GITLAB_USER_LOGIN
 *   CI_PIPELINE_URL / CI_JOB_URL - used to keep links fresh
 *   REVIEW_POST_RESULTS_PATH - override for review_post_results.json
 */

import * as fs from "fs/promises";
import { setupGitlabToken } from "../gitlab/token";
import { GitlabClient } from "../gitlab/api/client";
import { buildTrackingNoteBody } from "../gitlab/operations/tracking-note";
import {
  resolveOwnTrackingNoteId,
  resolvePostTarget,
} from "../gitlab/operations/post-target";
import {
  DEFAULT_ERROR_FILE,
  readErrorDetails,
} from "../gitlab/operations/error-details";
import { collectExecTelemetry } from "../gitlab/data/exec-telemetry";
import { readReviewPostOutcome } from "../core/review/tracking/results";
import { postResultsFilePath } from "./gitlab-post-review";
import { stateFilePath, type PrepareState } from "./gitlab-prepare";
import type { PostResults } from "./gitlab-post-review";
import {
  descriptionWithReview,
  renderGitlabSummary,
  stateOnlyNote,
  updateLifecycleAward,
  updateReviewStatus,
} from "../gitlab/operations/review-ux";
import { loadGitlabReviewConfig } from "../gitlab/operations/review-config";
import type { ReviewRenderInput } from "../core/review/render";

async function readPostResults() {
  const filePath = postResultsFilePath();
  const results = await readReviewPostOutcome(filePath);
  if (!results) {
    // Absent whenever posting did not get that far (skipped review, failed
    // pass). The note still renders, just without review counts.
    console.log(`No post-results file at ${filePath}; omitting review counts.`);
  }
  return results;
}

async function readState(): Promise<PrepareState | null> {
  const filePath = stateFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as PrepareState;
  } catch (err) {
    console.warn(`Could not read droid state file at ${filePath}:`, err);
    return null;
  }
}

async function run(): Promise<void> {
  const state = await readState();
  if (!state) {
    console.log("No droid state available; nothing to update.");
    return;
  }

  if (!state.shouldRunReview || !state.mrIid || !state.trackingNoteId) {
    console.log(
      `Skipping note update (shouldRunReview=${state.shouldRunReview}, ` +
        `mrIid=${state.mrIid}, trackingNoteId=${state.trackingNoteId}).`,
    );
    return;
  }

  const target = resolvePostTarget(state);

  const token = setupGitlabToken();
  const apiUrl =
    process.env.CI_API_V4_URL ||
    process.env.GITLAB_API_URL ||
    "https://gitlab.com/api/v4";

  const client = new GitlabClient(token, apiUrl);

  // Pass 1 exiting cleanly without usable candidates means nothing was
  // validated or posted; the note must not report that as a finished review.
  const skippedValidation = state.validatorSkippedReason
    ? `Pass 1 did not produce valid review candidates (${state.validatorSkippedReason}), so no findings were validated or posted.`
    : null;
  const jobFailed = process.env.DROID_SUCCESS === "false";
  const droidSuccess = !jobFailed && !skippedValidation;
  const errorDetails =
    (jobFailed
      ? await readErrorDetails(
          process.env.DROID_ERROR_FILE || DEFAULT_ERROR_FILE,
        )
      : null) ?? skippedValidation;
  const securityReviewRan = process.env.AUTOMATIC_SECURITY_REVIEW === "true";
  const triggerUsername =
    process.env.TRIGGER_USERNAME || process.env.GITLAB_USER_LOGIN || null;

  const pipelineUrl = process.env.CI_PIPELINE_URL || state.pipelineUrl;
  const jobUrl = process.env.CI_JOB_URL || state.jobUrl;

  const telemetry = await collectExecTelemetry({
    pass1LogPath:
      process.env.DROID_PASS1_LOG || "/tmp/droid-prompts/pass1-output.jsonl",
    pass2LogPath:
      process.env.DROID_PASS2_LOG || "/tmp/droid-prompts/pass2-output.jsonl",
  });

  const review = await readPostResults();

  if (state.reviewConfig || process.env.REVIEW_UX_V2 === "true") {
    const mr = await client.getMr(target.projectId, target.mrIid);
    const config = await loadGitlabReviewConfig(client, target.projectId, mr);
    let posted: PostResults | null = null;
    try {
      posted = JSON.parse(
        await fs.readFile(postResultsFilePath(), "utf8"),
      ) as PostResults;
    } catch {
      /* Failure before posting still renders a friendly error. */
    }
    const input: ReviewRenderInput = {
      ...(posted?.renderInput ?? {
        head: mr.diff_refs.head_sha,
        reviewState: state.previousReviewState ?? undefined,
        previousBody: state.summaryBody,
      }),
      platform: "gitlab" as const,
      state:
        droidSuccess && posted?.renderInput
          ? posted.renderInput.state
          : ("failed" as const),
      ...(droidSuccess && posted?.renderInput
        ? {}
        : {
            error: errorDetails ?? "Review did not produce validated results",
          }),
      durationSeconds: telemetry.totalDurationMs
        ? telemetry.totalDurationMs / 1000
        : undefined,
      jobUrl: jobUrl ?? undefined,
      // Post-results are a cache, not authority for a new-session task target.
      factoryFix: undefined,
    };
    const noteId = await resolveOwnTrackingNoteId(
      client,
      target,
      state.trackingNoteId,
    );
    const reviewedHead = process.env.DROID_REVIEW_HEAD_SHA;
    if (
      droidSuccess &&
      posted?.renderInput &&
      noteId !== null &&
      config.review_summary !== "off" &&
      process.env.DROID_SECURITY_FULL !== "true" &&
      reviewedHead &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(reviewedHead) &&
      mr.diff_refs.head_sha === reviewedHead &&
      input.head === reviewedHead
    )
      input.factoryFix = {
        reviewUrl:
          config.review_summary === "description"
            ? mr.web_url
            : `${mr.web_url}#note_${noteId}`,
        head: reviewedHead,
        runId: process.env.CI_JOB_ID,
      };
    const rendered = renderGitlabSummary(input);
    if (config.review_summary === "description")
      await client.updateMrDescription(
        target.projectId,
        target.mrIid,
        descriptionWithReview(mr.description ?? "", rendered),
      );
    const body =
      config.review_summary === "comment" ? rendered : stateOnlyNote(input);
    if (noteId === null)
      await client.createNote(target.projectId, target.mrIid, body);
    else await client.updateNote(target.projectId, target.mrIid, noteId, body);
    if (
      reviewedHead &&
      /^[a-f0-9]{40}$/i.test(reviewedHead) &&
      mr.diff_refs.head_sha === reviewedHead &&
      (posted?.renderInput == null || posted.renderInput.head === reviewedHead)
    )
      await updateReviewStatus(
        client,
        target.projectId,
        reviewedHead,
        input,
        config.review_check_run,
      );
    else
      console.warn(
        "Skipping review status: trusted review head is missing or does not match the live head and posted results.",
      );
    let lifecycleAward;
    try {
      lifecycleAward = JSON.parse(
        process.env.DROID_LIFECYCLE_AWARD_CONTEXT ?? "null",
      );
    } catch {
      /* Never trust model-writable state for award IDs. */
    }
    await updateLifecycleAward(
      client,
      target.projectId,
      target.mrIid,
      input.state === "failed"
        ? "failed"
        : input.state === "clean"
          ? "clean"
          : "done",
      config.review_reactions,
      lifecycleAward,
    );
    return;
  }

  const body = buildTrackingNoteBody({
    state: droidSuccess ? "success" : "failure",
    review,
    pipelineUrl,
    jobUrl,
    triggerUsername,
    errorDetails,
    securityReviewRan,
    telemetry: {
      totalNumTurns: telemetry.totalNumTurns,
      totalDurationMs: telemetry.totalDurationMs,
      totalCostUsd: telemetry.totalCostUsd,
      pass1SessionId: telemetry.pass1?.sessionId ?? null,
      pass2SessionId: telemetry.pass2?.sessionId ?? null,
    },
  });

  const noteId = await resolveOwnTrackingNoteId(
    client,
    target,
    state.trackingNoteId,
  );
  const outcome = droidSuccess ? "success" : "failure";
  if (noteId === null) {
    const created = await client.createNote(
      target.projectId,
      target.mrIid,
      body,
    );
    console.log(
      `Created tracking note ${created.id} on MR !${target.mrIid} (state=${outcome}).`,
    );
    return;
  }

  await client.updateNote(target.projectId, target.mrIid, noteId, body);
  console.log(
    `Updated tracking note ${noteId} on MR !${target.mrIid} (state=${outcome}).`,
  );
}

if (import.meta.main) {
  run().catch((error) => {
    console.error("gitlab-update-comment-link failed:", error);
    process.exit(1);
  });
}

export { run };
