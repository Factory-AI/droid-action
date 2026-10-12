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
 *   DROID_STATE_FILE       - JSON state written by gitlab-prepare
 *   DROID_SUCCESS          - "true" | "false" set by the CI job
 *   DROID_ERROR_DETAILS    - optional error blob to embed on failure
 *   AUTOMATIC_SECURITY_REVIEW - "true" to render the security badge
 *   TRIGGER_USERNAME       - optional, e.g. GITLAB_USER_LOGIN
 *   CI_PIPELINE_URL / CI_JOB_URL - used to keep links fresh
 *   REVIEW_POST_RESULTS_PATH - override for review_post_results.json
 */

import * as fs from "fs/promises";
import { setupGitlabToken } from "../gitlab/token";
import { GitlabClient } from "../gitlab/api/client";
import { buildTrackingNoteBody } from "../gitlab/operations/tracking-note";
import { collectExecTelemetry } from "../gitlab/data/exec-telemetry";
import { readReviewPostOutcome } from "../core/review/tracking/results";
import { postResultsFilePath } from "./gitlab-post-review";
import { stateFilePath, type PrepareState } from "./gitlab-prepare";
import { createLogger } from "../logger";

const log = createLogger("entrypoints/gitlab-update-comment-link");

async function readPostResults() {
  const filePath = postResultsFilePath();
  const results = await readReviewPostOutcome(filePath);
  if (!results) {
    // Absent whenever posting did not get that far (skipped review, failed
    // pass). The note still renders, just without review counts.
    log.info(`No post-results file at ${filePath}; omitting review counts.`);
  }
  return results;
}

async function readState(): Promise<PrepareState | null> {
  const filePath = stateFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as PrepareState;
  } catch (err) {
    log.warn(`Could not read droid state file at ${filePath}:`, err);
    return null;
  }
}

async function run(): Promise<void> {
  const state = await readState();
  if (!state) {
    log.info("No droid state available; nothing to update.");
    return;
  }

  if (!state.shouldRunReview || !state.mrIid || !state.trackingNoteId) {
    log.info(
      `Skipping note update (shouldRunReview=${state.shouldRunReview}, ` +
        `mrIid=${state.mrIid}, trackingNoteId=${state.trackingNoteId}).`,
    );
    return;
  }

  const token = setupGitlabToken();
  const apiUrl =
    process.env.CI_API_V4_URL ||
    process.env.GITLAB_API_URL ||
    "https://gitlab.com/api/v4";

  const client = new GitlabClient(token, apiUrl);

  const droidSuccess = process.env.DROID_SUCCESS !== "false";
  const errorDetails = process.env.DROID_ERROR_DETAILS || null;
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

  await client.updateNote(
    state.projectId,
    state.mrIid,
    state.trackingNoteId,
    body,
  );

  log.info(
    `Updated tracking note ${state.trackingNoteId} on MR !${state.mrIid} ` +
      `(state=${droidSuccess ? "success" : "failure"}).`,
  );
}

if (import.meta.main) {
  run().catch((error) => {
    log.error("gitlab-update-comment-link failed:", error);
    process.exit(1);
  });
}

export { run };
