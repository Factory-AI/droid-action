#!/usr/bin/env bun

/**
 * Final step: rewrites the sticky tracking thread with the outcome, the
 * posting counts from `review_post_results.json`, and pass telemetry.
 *
 * Env: DROID_SUCCESS ("false" on failure), DROID_ERROR_FILE (read only
 * if it is a regular file, then capped and redacted: the review passes can
 * rewrite the prompts directory it lives in),
 * DROID_PASS1_LOG / DROID_PASS2_LOG, plus the auth vars. The PR comes from
 * the pipeline's variables, and the thread named in the state file is only
 * edited after checking that this identity wrote it.
 */

import { AzureDevopsClient } from "../azure-devops/api/client";
import { azureDevopsApiVersion } from "../azure-devops/api/config";
import {
  azureDevopsSecretValues,
  setupAzureDevopsAuth,
} from "../azure-devops/token";
import {
  buildTrackingCommentBody,
  createTrackingThread,
  resolveOwnTrackingThread,
  resolveTrackingOwner,
} from "../azure-devops/operations/tracking-thread";
import { resolvePostTarget } from "../azure-devops/operations/post-target";
import { redactSecrets } from "../utils/redact-credentials";
import {
  postResultsFilePath,
  promptsDir,
  readState,
} from "../azure-devops/paths";
import { collectExecTelemetry } from "../gitlab/data/exec-telemetry";
import { readReviewPostOutcome } from "../core/review/tracking/results";
import { readErrorDetails } from "../gitlab/operations/error-details";
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

  const target = resolvePostTarget(state, env);
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
    errorDetails: success ? null : await errorDetails(env),
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
    collectionUri: target.collectionUri,
    project: target.project,
    repositoryId: target.repositoryId,
    auth: setupAzureDevopsAuth(env),
    apiVersion: azureDevopsApiVersion(env),
    fetch: deps.fetch,
  });
  const outcome = success ? "success" : "failure";
  const own = await resolveOwnTrackingThread({
    client,
    pullRequestId: target.pullRequestId,
    ownerId: await resolveTrackingOwner(client),
    hint: {
      threadId: state.trackingThreadId,
      commentId: state.trackingCommentId,
    },
  });
  if (!own) {
    const created = await createTrackingThread(
      client,
      target.pullRequestId,
      body,
    );
    console.log(
      `Created tracking thread ${created.threadId} (state=${outcome}).`,
    );
    return body;
  }
  await client.updateComment(
    target.pullRequestId,
    own.threadId,
    own.commentId,
    body,
  );
  console.log(`Updated tracking thread ${own.threadId} (state=${outcome}).`);
  return body;
}

async function errorDetails(env: NodeJS.ProcessEnv): Promise<string | null> {
  const text = await readErrorDetails(
    env.DROID_ERROR_FILE || path.join(promptsDir(env), "droid-error.txt"),
    env,
  );
  // readErrorDetails knows the raw env values; this adds the encoded forms.
  return text === null
    ? null
    : redactSecrets(text, azureDevopsSecretValues(env));
}

if (import.meta.main) {
  run().catch((error) => {
    console.error("azure-devops-update-comment-link failed:", error);
    process.exit(1);
  });
}
