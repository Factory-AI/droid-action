import { mkdir, writeFile } from "fs/promises";
import type { Octokits } from "../api/client";
import type { RepoReviewGuidelines } from "../../core/review/prompts/types";
import {
  REVIEW_GUIDELINES_SKILL_PATH,
  stripSkillFrontmatter,
} from "../../core/review/prompts/guidelines";

/**
 * Load the repository's review guidelines skill, if it has one, and keep a
 * copy under `${tempDir}/droid-prompts/` next to the other review artifacts.
 *
 * The file is read from the default branch, never from the pull request:
 * the text goes straight into the reviewer's prompt, and this also covers
 * pull requests branched before the guidelines landed. Returns undefined
 * when the repository has no guidelines or they cannot be read; a review
 * without guidelines is still a review.
 */
export async function fetchAndStoreReviewGuidelines(opts: {
  octokit: Octokits;
  owner: string;
  repo: string;
  /** Default branch name when the event payload carries it. */
  defaultBranch?: string;
  tempDir: string;
}): Promise<RepoReviewGuidelines | undefined> {
  const { octokit, owner, repo, defaultBranch, tempDir } = opts;
  const source = defaultBranch
    ? `${REVIEW_GUIDELINES_SKILL_PATH}@${defaultBranch}`
    : REVIEW_GUIDELINES_SKILL_PATH;

  let raw: string | undefined;
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: REVIEW_GUIDELINES_SKILL_PATH,
      ...(defaultBranch ? { ref: defaultBranch } : {}),
    });
    if (!Array.isArray(response.data) && "content" in response.data) {
      raw = Buffer.from(response.data.content, "base64").toString("utf8");
    }
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      console.log(`No review guidelines found at ${source}`);
    } else {
      console.warn(
        `Could not read review guidelines from ${source}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return undefined;
  }

  const body = raw === undefined ? "" : stripSkillFrontmatter(raw);
  if (!body) {
    console.log(`Review guidelines at ${source} are empty; skipping`);
    return undefined;
  }

  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });
  const path = `${promptsDir}/review_guidelines.md`;
  await writeFile(path, body);
  console.log(
    `Stored review guidelines (${body.length} chars, from ${source}) at ${path}`,
  );
  return { source, body, path };
}
