import type { Octokits } from "../api/client";
import { PR_QUERY, REPO_DEFAULT_BRANCH_QUERY } from "../api/queries/github";
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

type RepoDefaultBranchQueryResponse = {
  repository: {
    defaultBranchRef: {
      name: string;
    } | null;
  };
};

/**
 * Fetches the repository's default branch name.
 * Used by security-scan which operates without a PR context.
 */
export async function fetchRepoDefaultBranch({
  octokits,
  repository,
}: {
  octokits: Octokits;
  repository: { owner: string; repo: string };
}): Promise<string> {
  try {
    const result = await octokits.graphql<RepoDefaultBranchQueryResponse>(
      REPO_DEFAULT_BRANCH_QUERY,
      {
        owner: repository.owner,
        repo: repository.repo,
      },
    );

    if (!result.repository.defaultBranchRef) {
      throw new Error(`Default branch not found for ${repository.owner}/${repository.repo}`);
    }

    return result.repository.defaultBranchRef.name;
  } catch (error) {
    console.error(`Failed to fetch default branch:`, error);
    throw new Error(`Failed to fetch default branch for ${repository.owner}/${repository.repo}`);
  }
}
