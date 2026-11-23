import type { Octokits } from "../api/client";
import type { RepoReviewGuidelines } from "../../core/review/prompts/types";
import {
  loadStoredReviewGuidelines,
  prepareReviewGuidelines,
  REVIEW_GUIDELINES_ARTIFACT,
} from "../../core/review/artifacts/guidelines";
import { REVIEW_GUIDELINES_SKILL_PATH } from "../../core/review/prompts/guidelines";
import { retryWithBackoff } from "../../utils/retry";

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
  retryDelayMs?: number;
}): Promise<RepoReviewGuidelines | undefined> {
  const { octokit, owner, repo, baseRef, tempDir, retryDelayMs } = opts;
  return prepareReviewGuidelines({
    ref: baseRef,
    promptsDir: `${tempDir}/droid-prompts`,
    read: async (path, ref) => {
      try {
        const response = await retryWithBackoff(
          () => octokit.rest.repos.getContent({ owner, repo, path, ref }),
          {
            shouldRetry: isTransient,
            ...(retryDelayMs === undefined
              ? {}
              : { initialDelayMs: retryDelayMs }),
          },
        );
        if (Array.isArray(response.data) || !("content" in response.data)) {
          return null;
        }
        return Buffer.from(response.data.content, "base64").toString("utf8");
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throw error;
      }
    },
  });
}

/**
 * Reload the copy that the candidates step stored, for the validator
 * prompt. GitHub keeps no prepare state between the two steps, so the
 * location is recomputed from the same inputs the candidates step used.
 */
export function loadReviewGuidelinesStoredForValidator(opts: {
  baseRef: string;
  tempDir: string;
}): Promise<RepoReviewGuidelines | undefined> {
  return loadStoredReviewGuidelines({
    source: `${REVIEW_GUIDELINES_SKILL_PATH}@${opts.baseRef}`,
    path: `${opts.tempDir}/droid-prompts/${REVIEW_GUIDELINES_ARTIFACT}`,
  });
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404;
}

/**
 * Worth another attempt: a rate limit, a server error, or a failure below
 * HTTP (Octokit's request errors carry a status; fetch-level failures carry
 * a code). A 404 is a stable answer and anything else is a bug in the call.
 */
function isTransient(error: Error): boolean {
  const { status, code } = error as { status?: number; code?: string };
  if (status !== undefined) {
    return status === 429 || status >= 500;
  }
  return code !== undefined;
}
