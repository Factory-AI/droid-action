import type { Octokits } from "../api/client";
import { PR_QUERY, REPO_DEFAULT_BRANCH_QUERY } from "../api/queries/github";
import type { GitHubPullRequest } from "../types";
import { retryWithBackoff } from "../../utils/retry";

/**
 * Represents the PR data needed by fill and review commands
 */
export type PRBranchData = {
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  title: string;
  body: string;
};

type PullRequestQueryResponse = {
  repository: {
    pullRequest: GitHubPullRequest | null;
  } | null;
};

type RepoDefaultBranchQueryResponse = {
  repository: {
    defaultBranchRef: {
      name: string;
    } | null;
  } | null;
};

const GRAPHQL_RETRY_OPTIONS = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 4000,
};

type OctokitHttpResponse = {
  status: number;
  headers: Record<string, string | number | undefined>;
  data: unknown;
};

/**
 * Structural type for an `@octokit/request` hook. Octokit types
 * `request.hook` as `any`, so it is spelled out here to keep the capture below
 * type-checked.
 */
type OctokitRequestHook = (
  request: (options: unknown) => Promise<OctokitHttpResponse>,
  options: unknown,
) => Promise<OctokitHttpResponse>;

/**
 * Summarizes a value for an error message without dumping a whole response.
 */
function describePayload(payload: unknown): string {
  if (payload === undefined) {
    return "undefined";
  }
  if (payload === null) {
    return "null";
  }
  if (typeof payload === "string") {
    const preview = payload.slice(0, 200);
    return `string(${JSON.stringify(preview)}${payload.length > 200 ? "…" : ""})`;
  }
  if (typeof payload !== "object") {
    return `${typeof payload}(${String(payload)})`;
  }
  return `object with keys [${Object.keys(payload).join(", ")}]`;
}

/**
 * Runs a GraphQL query and returns one top-level field of the response.
 *
 * `@octokit/graphql` resolves `response.data.data` and only throws when the
 * body carries an `errors` array, so an HTTP 200 whose body is not a GraphQL
 * envelope (an HTML error page, or JSON without a `data` key) resolves
 * `undefined`. Dereferencing that directly turned a transient GitHub answer
 * into a `TypeError` that killed the whole action step, so the shape is checked
 * here and the request is retried: the same query has been observed to succeed
 * minutes earlier in the same job.
 *
 * A present-but-null field is returned as-is; GraphQL nulls a field the token
 * may not read, which is a stable "not found" answer rather than a broken
 * response, and the caller reports it without burning retries.
 */
async function fetchGraphQLField<T>({
  octokits,
  query,
  variables,
  field,
  queryDescription,
}: {
  octokits: Octokits;
  query: string;
  variables: Record<string, string | number>;
  field: string;
  queryDescription: string;
}): Promise<T> {
  return retryWithBackoff(async () => {
    // The HTTP response is captured through a request hook because
    // `@octokit/graphql` hands back only the `data` member, which leaves an
    // unexpected body impossible to diagnose from the action log.
    let httpStatus: number | undefined;
    let httpContentType: string | undefined;
    let httpBody: unknown;

    const captureResponse: OctokitRequestHook = async (request, options) => {
      const response = await request(options);
      httpStatus = response.status;
      httpContentType = String(response.headers["content-type"] ?? "");
      httpBody = response.data;
      return response;
    };

    const payload = await octokits.graphql<Record<string, unknown>>(query, {
      ...variables,
      request: { hook: captureResponse },
    });

    if (
      payload === null ||
      typeof payload !== "object" ||
      !(field in payload)
    ) {
      throw new Error(
        `${queryDescription} returned no "${field}" field ` +
          `(GraphQL data: ${describePayload(payload)}; ` +
          `HTTP ${httpStatus ?? "unknown"} ${httpContentType || "unknown content-type"}, ` +
          `body: ${describePayload(httpBody)})`,
      );
    }

    return payload[field] as T;
  }, GRAPHQL_RETRY_OPTIONS);
}

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
    const repositoryResult = await fetchGraphQLField<
      PullRequestQueryResponse["repository"]
    >({
      octokits,
      query: PR_QUERY,
      variables: {
        owner: repository.owner,
        repo: repository.repo,
        number: prNumber,
      },
      field: "repository",
      queryDescription: `PR query for ${repository.owner}/${repository.repo}#${prNumber}`,
    });

    const pullRequest = repositoryResult?.pullRequest;

    if (!pullRequest) {
      throw new Error(`PR #${prNumber} not found`);
    }

    return {
      baseRefName: pullRequest.baseRefName,
      headRefName: pullRequest.headRefName,
      headRefOid: pullRequest.headRefOid,
      title: pullRequest.title,
      body: pullRequest.body ?? "",
    };
  } catch (error) {
    console.error(`Failed to fetch PR branch data:`, error);
    throw new Error(
      `Failed to fetch PR branch data for PR #${prNumber}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

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
    const repositoryResult = await fetchGraphQLField<
      RepoDefaultBranchQueryResponse["repository"]
    >({
      octokits,
      query: REPO_DEFAULT_BRANCH_QUERY,
      variables: {
        owner: repository.owner,
        repo: repository.repo,
      },
      field: "repository",
      queryDescription: `Default branch query for ${repository.owner}/${repository.repo}`,
    });

    const defaultBranchRef = repositoryResult?.defaultBranchRef;

    if (!defaultBranchRef) {
      throw new Error(
        `Default branch not found for ${repository.owner}/${repository.repo}`,
      );
    }

    return defaultBranchRef.name;
  } catch (error) {
    console.error(`Failed to fetch default branch:`, error);
    throw new Error(
      `Failed to fetch default branch for ${repository.owner}/${repository.repo}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
