#!/usr/bin/env bun

/**
 * Final step, run whether or not the review succeeded: render the final
 * tracking comment (status, summary, counts, telemetry) and, when enabled,
 * the final `droid-review` build status.
 *
 * Env: DROID_SUCCESS ("false" on failure), DROID_ERROR_FILE (read only if
 * it is a regular file, capped and redacted),
 * DROID_PASS1_LOG / DROID_PASS2_LOG, plus the credentials.
 */

import { createBitbucketClient } from "../bitbucket/api/client";
import { resolveBitbucketAuth } from "../bitbucket/token";
import {
  buildTrackingCommentBody,
  isOwnComment,
  isTrackingComment,
} from "../bitbucket/operations/tracking-comment";
import { postResultsFilePath, readState } from "../bitbucket/state";
import { collectExecTelemetry } from "../gitlab/data/exec-telemetry";
import { readErrorDetails } from "../gitlab/operations/error-details";
import { readReviewPostOutcome } from "../core/review/tracking/results";
import { reportBuildStatus, resolvePostTarget } from "./bitbucket-prepare";
import type { BitbucketClient } from "../bitbucket/types";

/**
 * The tracking comment to edit. The ID in state is only a hint, since the
 * review passes can rewrite the state file: it must be a top-level tracking
 * comment on this pull request, written by these credentials when the
 * server says who they are. Otherwise a new comment is posted.
 */
async function ownTrackingCommentId(
  client: BitbucketClient,
  hintedId: number,
): Promise<number | null> {
  const [comments, currentUserId] = await Promise.all([
    client.listComments(),
    client.getCurrentUserId(),
  ]);
  const hinted = comments.find((c) => c.id === hintedId);
  if (
    hinted &&
    isTrackingComment(hinted) &&
    (currentUserId === null || isOwnComment(hinted, currentUserId))
  ) {
    return hinted.id;
  }
  console.warn(
    `Comment ${hintedId} is not a Droid tracking comment these credentials wrote on this pull request; posting a new one instead.`,
  );
  return null;
}

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

  // Pass 1 exiting cleanly without usable candidates means nothing was
  // validated or posted; a passing droid-review build must not hide that.
  const skippedValidation = state.validatorSkippedReason
    ? `Pass 1 did not produce valid review candidates (${state.validatorSkippedReason}), so no findings were validated or posted.`
    : null;
  const success =
    process.env.DROID_SUCCESS !== "false" &&
    state.shouldRunReview &&
    !skippedValidation;
  const jobFailed = process.env.DROID_SUCCESS === "false";
  const errorDetails =
    (jobFailed && process.env.DROID_ERROR_FILE
      ? await readErrorDetails(process.env.DROID_ERROR_FILE)
      : null) ??
    (state.shouldRunReview
      ? skippedValidation
      : "The prepare step did not finish.");

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

  const target = resolvePostTarget(state);
  const client = createBitbucketClient(target, resolveBitbucketAuth(), options);
  const commentId = await ownTrackingCommentId(client, state.trackingCommentId);
  if (commentId === null) {
    const created = await client.createComment(body);
    console.log(
      `Posted tracking comment ${created.id} on PR #${target.prId} (${success ? "success" : "failure"}).`,
    );
  } else {
    await client.updateComment(commentId, body);
    console.log(
      `Updated tracking comment ${commentId} on PR #${target.prId} (${success ? "success" : "failure"}).`,
    );
  }

  if (state.buildStatus) {
    await reportBuildStatus(
      client,
      state.headSha,
      state.buildUrl ?? state.prWebUrl,
      success ? "SUCCESSFUL" : "FAILED",
      success ? "Droid review finished" : "Droid review failed",
      state.sourceBranch,
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
