#!/usr/bin/env bun

/**
 * Final step, run whether or not the review succeeded: render the final
 * tracking comment (status, summary, counts, telemetry) and, when enabled,
 * the final `droid-review` build status.
 *
 * Env: DROID_SUCCESS ("false" on failure), DROID_ERROR_DETAILS,
 * DROID_PASS1_LOG / DROID_PASS2_LOG, plus the credentials.
 */

import { createBitbucketClient } from "../bitbucket/api/client";
import { resolveBitbucketAuth } from "../bitbucket/token";
import { buildTrackingCommentBody } from "../bitbucket/operations/tracking-comment";
import { postResultsFilePath, readState } from "../bitbucket/state";
import { collectExecTelemetry } from "../gitlab/data/exec-telemetry";
import { readReviewPostOutcome } from "../core/review/tracking/results";
import { reportBuildStatus } from "./bitbucket-prepare";

export async function run(
  options: { retryDelayMs?: number } = {},
): Promise<void> {
  const state = await readState();
  if (!state) {
    console.log("No droid state available; nothing to update.");
    return;
  }
  if (!state.target || !state.trackingCommentId) {
    console.log(
      `No tracking comment to update (reason: ${state.reason ?? "none"}).`,
    );
    return;
  }

  const success =
    process.env.DROID_SUCCESS !== "false" && state.shouldRunReview;
  const errorDetails =
    process.env.DROID_ERROR_DETAILS ||
    (state.shouldRunReview ? null : "The prepare step did not finish.");

  const telemetry = await collectExecTelemetry({
    pass1LogPath: process.env.DROID_PASS1_LOG || null,
    pass2LogPath: process.env.DROID_PASS2_LOG || null,
  });
  let review = null;
  try {
    review = await readReviewPostOutcome(postResultsFilePath());
  } catch (error) {
    console.warn(
      `Ignoring unreadable post results: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const body = buildTrackingCommentBody({
    state: success ? "success" : "failure",
    review,
    pipelineUrl: state.buildUrl,
    errorDetails,
    securityReviewRan: state.securityReviewEnabled,
    diffTruncated: state.diffTruncated === true,
    telemetry: {
      totalNumTurns: telemetry.totalNumTurns,
      totalDurationMs: telemetry.totalDurationMs,
      totalCostUsd: telemetry.totalCostUsd,
      pass1SessionId: telemetry.pass1?.sessionId ?? null,
      pass2SessionId: telemetry.pass2?.sessionId ?? null,
    },
  });

  const client = createBitbucketClient(
    state.target,
    resolveBitbucketAuth(),
    options,
  );
  await client.updateComment(state.trackingCommentId, body);
  console.log(
    `Updated tracking comment ${state.trackingCommentId} on PR #${state.prId} (${success ? "success" : "failure"}).`,
  );

  if (state.buildStatus) {
    await reportBuildStatus(
      client,
      state.headSha,
      state.buildUrl ?? state.prWebUrl,
      success ? "SUCCESSFUL" : "FAILED",
      success ? "Droid review finished" : "Droid review failed",
    );
  }
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(
      "bitbucket-update-comment-link failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
}
