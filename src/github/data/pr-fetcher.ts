import type { Octokits } from "../api/client";
import { PR_QUERY } from "../api/queries/github";
import type { GitHubPullRequest } from "../types";

/**
 * Represents the PR data needed by fill and review commands
 */
export type PRBranchData = {
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
};

type PullRequestQueryResponse = {
  repository: {
    pullRequest: GitHubPullRequest | null;
  };
};

/**
 * Fetches PR branch information needed for fill/review commands.
 * This is a focused function that only retrieves the branch names and SHA
 * that are actually used, avoiding expensive operations like fetching
 * all comments, files, or computing SHAs.
 */
export async function fetchPRBranchData({
  octokits,
  repository,
  prNumber,
}: {
  octokits: Octokits;
  repository: { owner: string; repo: string };
  prNumber: number;
}): Promise<PRBranchData> {
  try {
    const prResult = await octokits.graphql<PullRequestQueryResponse>(
      PR_QUERY,
      {
        owner: repository.owner,
        repo: repository.repo,
        number: prNumber,
      },
    );

    if (!prResult.repository.pullRequest) {
      throw new Error(`PR #${prNumber} not found`);
    }

    const pullRequest = prResult.repository.pullRequest;

    return {
      baseRefName: pullRequest.baseRefName,
      headRefName: pullRequest.headRefName,
      headRefOid: pullRequest.headRefOid,
    };
  } catch (error) {
    console.error(`Failed to fetch PR branch data:`, error);
    throw new Error(`Failed to fetch PR branch data for PR #${prNumber}`);
  }
}
