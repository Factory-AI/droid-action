#!/usr/bin/env bun

/**
 * Final step: rewrites the sticky tracking thread with the outcome, the
 * posting counts from `review_post_results.json`, and pass telemetry.
 *
 * Env: DROID_SUCCESS ("false" on failure), DROID_ERROR_DETAILS,
 * DROID_PASS1_LOG / DROID_PASS2_LOG, plus the auth vars.
 */

import { AzureDevopsClient } from "../azure-devops/api/client";
import { azureDevopsApiVersion } from "../azure-devops/api/config";
import { setupAzureDevopsAuth } from "../azure-devops/token";
import { buildTrackingCommentBody } from "../azure-devops/operations/tracking-thread";
import {
  postResultsFilePath,
  promptsDir,
  readState,
} from "../azure-devops/paths";
import { collectExecTelemetry } from "../gitlab/data/exec-telemetry";
import { readReviewPostOutcome } from "../core/review/tracking/results";
import * as path from "path";

export async function run(
  deps: {
    env?: NodeJS.ProcessEnv;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
  } = {},
): Promise<string | null> {
  const env = deps.env ?? process.env;
  const state = await readState(env);
  if (
    !state ||
    !state.shouldRunReview ||
    !state.pullRequestId ||
    !state.trackingThreadId ||
    !state.trackingCommentId
  ) {
    console.log("No tracking thread to update.");
    return null;
  }

  const success = env.DROID_SUCCESS !== "false";
  const telemetry = await collectExecTelemetry({
    pass1LogPath:
      env.DROID_PASS1_LOG || path.join(promptsDir(env), "pass1-output.jsonl"),
    pass2LogPath:
      env.DROID_PASS2_LOG || path.join(promptsDir(env), "pass2-output.jsonl"),
  });

  let review: Awaited<ReturnType<typeof readReviewPostOutcome>> = null;
  try {
    review = await readReviewPostOutcome(postResultsFilePath(env));
  } catch (error) {
    // Finalizing the thread matters more than the posting counts.
    console.warn(
      "Ignoring unreadable review_post_results.json:",
      error instanceof Error ? error.message : error,
    );
  }

  const body = buildTrackingCommentBody({
    state: success ? "success" : "failure",
    review,
    pipelineUrl: state.buildUrl,
    jobUrl: state.jobUrl,
    triggerUsername: state.triggeredBy,
    errorDetails: env.DROID_ERROR_DETAILS || null,
    securityReviewRan: state.securityReviewEnabled,
    telemetry: {
      totalNumTurns: telemetry.totalNumTurns,
      totalDurationMs: telemetry.totalDurationMs,
      totalCostUsd: telemetry.totalCostUsd,
      pass1SessionId: telemetry.pass1?.sessionId ?? null,
      pass2SessionId: telemetry.pass2?.sessionId ?? null,
    },
  });

  const client = new AzureDevopsClient({
    collectionUri: state.collectionUri,
    project: state.project,
    repositoryId: state.repositoryId,
    auth: setupAzureDevopsAuth(env),
    apiVersion: azureDevopsApiVersion(env),
    fetch: deps.fetch,
  });
  await client.updateComment(
    state.pullRequestId,
    state.trackingThreadId,
    state.trackingCommentId,
    body,
  );
  console.log(
    `Updated tracking thread ${state.trackingThreadId} (state=${success ? "success" : "failure"}).`,
  );
  return body;
}

if (import.meta.main) {
  run().catch((error) => {
    console.error("azure-devops-update-comment-link failed:", error);
    process.exit(1);
  });
}
