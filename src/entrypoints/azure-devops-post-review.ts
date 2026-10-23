#!/usr/bin/env bun

/**
 * Posts the findings Pass 2 approved as Azure DevOps PR threads.
 * `parseValidatedReview` is the trust boundary: only entries explicitly
 * marked "approved" with a usable anchor are posted.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { AzureDevopsClient } from "../azure-devops/api/client";
import { azureDevopsApiVersion } from "../azure-devops/api/config";
import { setupAzureDevopsAuth } from "../azure-devops/token";
import { postReview } from "../azure-devops/operations/post-review";
import { resolvePostTarget } from "../azure-devops/operations/post-target";
import {
  postResultsFilePath,
  readState,
  validatedFilePath,
} from "../azure-devops/paths";
import type { AdoIterationChange } from "../azure-devops/types";
import {
  buildUnifiedDiffIndex,
  type FileLineIndex,
} from "../core/review/validated/diff";
import { parseValidatedReview } from "../core/review/validated/parse";
import type { ReviewPostResults } from "../core/review/tracking/types";

export async function run(
  deps: {
    env?: NodeJS.ProcessEnv;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
  } = {},
): Promise<ReviewPostResults | null> {
  const env = deps.env ?? process.env;
  const state = await readState(env);
  if (!state) {
    throw new Error(
      "azure-devops-post-review: no state file; did azure-devops-prepare succeed?",
    );
  }
  if (!state.shouldRunReview) {
    console.log(
      `Review skipped (${state.reason ?? "unknown"}); nothing to post.`,
    );
    return null;
  }
  if (state.validatorSkippedReason) {
    console.log(
      `Pass 2 was skipped (${state.validatorSkippedReason}); nothing to post.`,
    );
    return null;
  }
  const target = resolvePostTarget(state, env);
  const pullRequestId = target.pullRequestId;
  const iterationId = state.iterationId;
  if (!state.pullRequestId || !iterationId) {
    throw new Error(
      "azure-devops-post-review: state is missing pullRequestId or iterationId",
    );
  }

  const validatedPath = state.validatedPath ?? validatedFilePath(env);
  let raw: string;
  try {
    raw = await fs.readFile(validatedPath, "utf8");
  } catch {
    throw new Error(
      `azure-devops-post-review: Pass 2 did not write ${validatedPath}; ` +
        "refusing to report a successful review with no posted findings.",
    );
  }
  const parsed = parseValidatedReview(raw);
  console.log(
    `Validated review: ${parsed.approvedCount} approved, ` +
      `${parsed.rejectedCount} rejected, ${parsed.skipped.length} unusable.`,
  );

  const client = new AzureDevopsClient({
    collectionUri: target.collectionUri,
    project: target.project,
    repositoryId: target.repositoryId,
    auth: setupAzureDevopsAuth(env),
    apiVersion: azureDevopsApiVersion(env),
    fetch: deps.fetch,
  });

  let diffIndex: Map<string, FileLineIndex> | null = null;
  if (state.diffPath) {
    try {
      diffIndex = buildUnifiedDiffIndex(
        await fs.readFile(state.diffPath, "utf8"),
      );
    } catch (error) {
      console.warn(
        "Could not read the PR diff; posting without a line index:",
        error,
      );
    }
  }

  let changes: AdoIterationChange[] = [];
  if (parsed.approved.length > 0) {
    try {
      changes = await client.listIterationChanges(pullRequestId, iterationId);
    } catch (error) {
      // Threads still anchor without changeTrackingId; Azure DevOps just
      // tracks them less precisely across later pushes.
      console.warn(
        "Could not fetch iteration changes; posting without changeTrackingId:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const result = await postReview({
    client,
    pullRequestId,
    iterationId,
    changes,
    diffIndex,
    comments: parsed.approved,
  });

  const results: ReviewPostResults = {
    posted: result.posted,
    fallbackPosted: result.fallbackPosted,
    approved: parsed.approvedCount,
    rejected: parsed.rejectedCount,
    failed: result.failures.length,
    skipped: parsed.skipped.length,
    summaryBody: parsed.summaryBody,
    failures: result.failures,
  };
  const resultsPath = postResultsFilePath(env);
  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
  console.log(
    `Posted ${results.posted}/${parsed.approved.length} inline threads ` +
      `(${results.fallbackPosted} as general comments) on PR !${pullRequestId}.`,
  );

  if (
    parsed.approved.length > 0 &&
    results.posted === 0 &&
    results.fallbackPosted === 0
  ) {
    throw new Error(
      `azure-devops-post-review: all ${parsed.approved.length} approved comments failed to post. ` +
        `First error: ${results.failures[0]?.error ?? "unknown"}`,
    );
  }
  if (results.failed > 0) {
    // Some findings reached the PR, so the review is not a failure, but the
    // build should say it is incomplete so someone re-queues it.
    console.log(
      `##vso[task.logissue type=warning]${results.failed} of ${parsed.approved.length} approved findings could not be posted. ` +
        `First error: ${results.failures[0]?.error ?? "unknown"}`,
    );
    console.log("##vso[task.complete result=SucceededWithIssues;]");
  }
  return results;
}

if (import.meta.main) {
  run().catch((error) => {
    console.error("azure-devops-post-review failed:", error);
    process.exit(1);
  });
}
