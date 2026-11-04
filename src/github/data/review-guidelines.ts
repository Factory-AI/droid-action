import type { Octokits } from "../api/client";
import type { RepoReviewGuidelines } from "../../core/review/prompts/types";
import { prepareReviewGuidelines } from "../../core/review/artifacts/guidelines";

/**
 * Load the repository's review guidelines skill from the pull request's
 * base branch and keep a copy under `${tempDir}/droid-prompts/` next to
 * the other review artifacts. See `prepareReviewGuidelines` for why the
 * base branch, and for the no-guidelines behaviour.
 */
export async function fetchAndStoreReviewGuidelines(opts: {
  octokit: Octokits;
  owner: string;
  repo: string;
  baseRef: string;
  tempDir: string;
}): Promise<RepoReviewGuidelines | undefined> {
  const { octokit, owner, repo, baseRef, tempDir } = opts;
  return prepareReviewGuidelines({
    ref: baseRef,
    promptsDir: `${tempDir}/droid-prompts`,
    read: async (path, ref) => {
      try {
        const response = await octokit.rest.repos.getContent({
          owner,
          repo,
          path,
          ref,
        });
        if (Array.isArray(response.data) || !("content" in response.data)) {
          return null;
        }
        return Buffer.from(response.data.content, "base64").toString("utf8");
      } catch (error) {
        if ((error as { status?: number }).status === 404) {
          return null;
        }
        throw error;
      }
    },
  });
}
