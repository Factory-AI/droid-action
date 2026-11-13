import { z } from "zod";
import { GITHUB_API_URL } from "../../github/api/config";
import { retryWithBackoff } from "../../utils/retry";
import {
  RiskError,
  type PullRequestRiskFile,
  type PullRequestRiskFileStatus,
  type RiskFetch,
} from "./types";

const PAGE_SIZE = 100;
// GitHub lists at most 3,000 files for a pull request.
const MAX_PAGES = 30;
const REQUEST_TIMEOUT_MS = 30_000;

const FILE_STATUSES: readonly PullRequestRiskFileStatus[] = [
  "added",
  "removed",
  "modified",
  "renamed",
  "copied",
  "changed",
  "unchanged",
];

const FilesPageSchema = z.array(
  z.object({
    filename: z.string(),
    previous_filename: z.string().optional(),
    status: z.string(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
);

const PullRequestSchema = z.object({
  title: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changed_files: z.number().int().nonnegative(),
  head: z.object({ sha: z.string() }),
  base: z.object({ sha: z.string() }),
});

export type GitHubReadOptions = {
  repo: string;
  pr: number;
  token: string;
  apiUrl?: string;
  fetch?: RiskFetch;
  retryDelayMs?: number;
};

class GitHubReadError extends RiskError {
  constructor(
    readonly status: number | undefined,
    message: string,
  ) {
    super("pr_metadata_unavailable", message);
  }
}

async function githubGet(
  path: string,
  options: GitHubReadOptions,
): Promise<unknown> {
  const request: RiskFetch = options.fetch ?? fetch;
  const url = `${options.apiUrl ?? GITHUB_API_URL}${path}`;
  return retryWithBackoff(
    async () => {
      let response: Response;
      try {
        response = await request(url, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${options.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new GitHubReadError(
          undefined,
          `Could not reach GitHub for ${path}`,
        );
      }
      if (!response.ok) {
        throw new GitHubReadError(
          response.status,
          `GitHub answered ${response.status} for ${path}`,
        );
      }
      return response.json();
    },
    {
      maxAttempts: 3,
      initialDelayMs: options.retryDelayMs ?? 1000,
      maxDelayMs: 4000,
      shouldRetry: (error) =>
        error instanceof GitHubReadError &&
        (error.status === undefined || error.status >= 500),
    },
  );
}

/**
 * Lists the pull request's changed files. A pull request with more files than
 * GitHub lists yields a short inventory, which the snapshot reports as
 * unlisted files.
 */
export async function listPullRequestFiles(
  options: GitHubReadOptions,
): Promise<PullRequestRiskFile[]> {
  const files: PullRequestRiskFile[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const rows = FilesPageSchema.parse(
      await githubGet(
        `/repos/${options.repo}/pulls/${options.pr}/files?per_page=${PAGE_SIZE}&page=${page}`,
        options,
      ),
    );
    for (const row of rows) {
      const status = FILE_STATUSES.find((known) => known === row.status);
      files.push({
        filename: row.filename,
        ...(row.previous_filename
          ? { previousFilename: row.previous_filename }
          : {}),
        status: status ?? "changed",
        additions: row.additions,
        deletions: row.deletions,
      });
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return files;
}

/** Reads the pull request facts Factory otherwise supplies, for offline runs. */
export async function getPullRequestSummary(options: GitHubReadOptions) {
  const pullRequest = PullRequestSchema.parse(
    await githubGet(`/repos/${options.repo}/pulls/${options.pr}`, options),
  );
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
