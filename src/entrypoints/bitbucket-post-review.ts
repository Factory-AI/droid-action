#!/usr/bin/env bun

/**
 * Posting step: reads `review_validated.json` (Pass 2), posts approved
 * findings as inline comments, and writes `review_post_results.json` for
 * the tracking comment. `parseValidatedReview` is the trust boundary: only
 * entries explicitly marked approved with a usable anchor can post.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { createBitbucketClient } from "../bitbucket/api/client";
import { resolveBitbucketAuth } from "../bitbucket/token";
import { postReview } from "../bitbucket/operations/post-review";
import {
  postResultsFilePath,
  readState,
  validatedFilePath,
} from "../bitbucket/state";
import {
  buildUnifiedDiffIndex,
  type FileLineIndex,
} from "../core/review/validated/diff";
import { parseValidatedReview } from "../core/review/validated/parse";
import type { ReviewPostResults } from "../core/review/tracking/types";

export async function run(
  options: { retryDelayMs?: number } = {},
): Promise<void> {
  const state = await readState();
  if (!state) {
    throw new Error(
      "bitbucket-post-review: no state file; did bitbucket-prepare run?",
    );
  }
  if (!state.shouldRunReview) {
    console.log(
      `Review was skipped (${state.reason ?? "unknown"}); nothing to post.`,
    );
    return;
  }
  if (state.validatorSkippedReason) {
    console.log(
      `Pass 2 was skipped (${state.validatorSkippedReason}); nothing to post.`,
    );
    return;
  }
  if (!state.target) {
    throw new Error(
      "bitbucket-post-review: state is missing the pull request target",
    );
  }

  const validatedPath = state.validatedPath ?? validatedFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(validatedPath, "utf8");
  } catch {
    throw new Error(
      `bitbucket-post-review: Pass 2 did not write ${validatedPath}; ` +
        "refusing to report a successful review with no posted findings.",
    );
  }
  const parsed = parseValidatedReview(raw);
  console.log(
    `Validated review: ${parsed.approvedCount} approved, ${parsed.rejectedCount} rejected, ` +
      `${parsed.skipped.length} unusable.`,
  );

  // The diff artifact from prepare is exactly what the passes reviewed.
  let index: Map<string, FileLineIndex> | null = null;
  if (state.diffPath) {
    try {
      index = buildUnifiedDiffIndex(await fs.readFile(state.diffPath, "utf8"));
    } catch (error) {
      console.warn(
        `Could not read the diff artifact; posting without a line index: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const client = createBitbucketClient(
    state.target,
    resolveBitbucketAuth(),
    options,
  );
  const result = await postReview({ client, comments: parsed.approved, index });

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
  const resultsPath = postResultsFilePath();
  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
  console.log(
    `Posted ${results.posted}/${parsed.approved.length} inline comments ` +
      `(${results.fallbackPosted} as regular comments) on PR #${state.prId}.`,
  );

  if (
    parsed.approved.length > 0 &&
    results.posted === 0 &&
    results.fallbackPosted === 0
  ) {
    throw new Error(
      `bitbucket-post-review: all ${parsed.approved.length} approved comments failed to post. ` +
        `First error: ${results.failures[0]?.error ?? "unknown"}`,
    );
  }
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(
      "bitbucket-post-review failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
}
