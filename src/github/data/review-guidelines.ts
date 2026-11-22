import type { Octokits } from "../api/client";
import type { RepoReviewGuidelines } from "../../core/review/prompts/types";
import {
  loadStoredReviewGuidelines,
  prepareReviewGuidelines,
  REVIEW_GUIDELINES_ARTIFACT,
} from "../../core/review/artifacts/guidelines";
import {
  isReviewSkillName,
  REVIEW_GUIDELINES_SKILL_PATH,
  REVIEW_SKILL_DIR,
  REVIEW_SKILL_PLUGIN_DIR,
  reviewSkillPath,
} from "../../core/review/prompts/guidelines";
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
  return prepareReviewGuidelines({
    ref: opts.baseRef,
    promptsDir: `${opts.tempDir}/droid-prompts`,
    read: readFromRepository(opts),
  });
}

export type RequestedReviewSkill =
  | { status: "found"; skill: RepoReviewGuidelines }
  | { status: "missing" }
  | { status: "ambiguous"; paths: string[] };

/**
 * Find the skill an `@droid review /<name>` command names on the base
 * branch: `.factory/skills/<name>` wins outright; otherwise exactly one
 * plugin may have it, and two or more are refused as ambiguous rather than
 * picked by order. A failed GitHub read fails the run instead of being
 * reported as a missing skill.
 */
export async function fetchRequestedReviewSkill(opts: {
  octokit: Octokits;
  owner: string;
  repo: string;
  baseRef: string;
  tempDir: string;
  name: string;
  retryDelayMs?: number;
}): Promise<RequestedReviewSkill> {
  const read = readFromRepository(opts);
  const probe = async (path: string) => {
    const text = await read(path, opts.baseRef);
    return text?.trim() ? { path, text } : undefined;
  };
  let hits = [await probe(reviewSkillPath(REVIEW_SKILL_DIR, opts.name))];
  if (!hits[0]) {
    const plugins = (
      await listDirectories(opts)(REVIEW_SKILL_PLUGIN_DIR, opts.baseRef)
    )
      .filter(isReviewSkillName)
      .sort();
    hits = await Promise.all(
      plugins.map((plugin) =>
        probe(
          reviewSkillPath(
            `${REVIEW_SKILL_PLUGIN_DIR}/${plugin}/skills`,
            opts.name,
          ),
        ),
      ),
    );
  }
  const found = hits.filter((hit) => hit !== undefined);
  if (found.length > 1) {
    return { status: "ambiguous", paths: found.map((hit) => hit.path) };
  }
  const [hit] = found;
  const skill = hit
    ? await prepareReviewGuidelines({
        ref: opts.baseRef,
        promptsDir: `${opts.tempDir}/droid-prompts`,
        read: async () => hit.text,
        skillPath: hit.path,
        artifact: "requested_review_skill.md",
      })
    : undefined;
  return skill ? { status: "found", skill } : { status: "missing" };
}

function listDirectories(opts: {
  octokit: Octokits;
  owner: string;
  repo: string;
  retryDelayMs?: number;
}): (path: string, ref: string) => Promise<string[]> {
  const { octokit, owner, repo, retryDelayMs } = opts;
  return async (path, ref) => {
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
      return Array.isArray(response.data)
        ? response.data
            .filter((entry) => entry.type === "dir")
            .map((entry) => entry.name)
        : [];
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }
  };
}

function readFromRepository(opts: {
  octokit: Octokits;
  owner: string;
  repo: string;
  retryDelayMs?: number;
}): (path: string, ref: string) => Promise<string | null> {
  const { octokit, owner, repo, retryDelayMs } = opts;
  return async (path, ref) => {
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
  };
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
