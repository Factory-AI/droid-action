import { z } from "zod";
import { RiskError } from "../../core/risk/types";
import { retryWithBackoff } from "../../utils/retry";
import type { Octokits } from "../api/client";

const REQUEST_TIMEOUT_MS = 30_000;

const PullRequestSchema = z.object({
  title: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
  head: z.object({ sha: z.string() }),
  base: z.object({ sha: z.string() }),
});

/**
 * Reads the pull request facts Factory otherwise supplies, for a PR risk
 * judge run offline. A request GitHub did not answer, or answered with a
 * server error, is made up to three times.
 */
export async function fetchPullRequestRiskSummary({
  octokits,
  repository,
  prNumber,
}: {
  octokits: Octokits;
  repository: { owner: string; repo: string };
  prNumber: number;
}) {
  let data: unknown;
  try {
    ({ data } = await retryWithBackoff(
      () =>
        octokits.rest.pulls.get({
          owner: repository.owner,
          repo: repository.repo,
          pull_number: prNumber,
          request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        }),
      {
        maxAttempts: 3,
        initialDelayMs: 1000,
        maxDelayMs: 4000,
        // Octokit reports a request that got no answer as a 500, and a
        // request that timed out with no status at all.
        shouldRetry: (error) =>
          !("status" in error) || Number(error.status) >= 500,
      },
    ));
  } catch (error) {
    throw new RiskError(
      "pr_metadata_unavailable",
      `GitHub did not return ${repository.owner}/${repository.repo}#${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  const pullRequest = PullRequestSchema.parse(data);
  return {
    headSha: pullRequest.head.sha,
    baseSha: pullRequest.base.sha,
    pullRequest: {
      title: pullRequest.title,
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changed_files,
    },
  };
}
