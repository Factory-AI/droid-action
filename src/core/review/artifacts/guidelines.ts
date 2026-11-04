import { mkdir, readFile, writeFile } from "fs/promises";
import type { RepoReviewGuidelines } from "../prompts/types";
import {
  REVIEW_GUIDELINES_SKILL_PATH,
  stripSkillFrontmatter,
} from "../prompts/guidelines";

/** Basename of the on-disk copy, next to the diff and description. */
export const REVIEW_GUIDELINES_ARTIFACT = "review_guidelines.md";

/**
 * What a platform's prepare state keeps about the guidelines so the
 * validator prepare, which makes no API calls, can reload the text.
 */
export type StoredReviewGuidelines = Pick<
  RepoReviewGuidelines,
  "source" | "path"
>;

/**
 * Read the repository's review guidelines skill from `ref` and keep a copy
 * under `promptsDir`.
 *
 * `ref` is the branch the change merges into, never the change itself:
 * the text goes straight into the reviewer's prompt, and reading it from
 * the target also covers changes branched before the guidelines landed.
 * `read` resolves to null when the file does not exist on that branch.
 * Returns undefined when there are no guidelines or they cannot be read;
 * a review without guidelines is still a review.
 */
export async function prepareReviewGuidelines(opts: {
  ref: string;
  promptsDir: string;
  read: (filePath: string, ref: string) => Promise<string | null>;
}): Promise<RepoReviewGuidelines | undefined> {
  const { ref, promptsDir, read } = opts;
  const source = `${REVIEW_GUIDELINES_SKILL_PATH}@${ref}`;

  let raw: string | null;
  try {
    raw = await read(REVIEW_GUIDELINES_SKILL_PATH, ref);
  } catch (error) {
    console.warn(
      `Could not read review guidelines from ${source}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
  if (raw === null) {
    console.log(`No review guidelines found at ${source}`);
    return undefined;
  }

  const body = stripSkillFrontmatter(raw);
  if (!body) {
    console.log(`Review guidelines at ${source} are empty; skipping`);
    return undefined;
  }

  await mkdir(promptsDir, { recursive: true });
  const path = `${promptsDir}/${REVIEW_GUIDELINES_ARTIFACT}`;
  await writeFile(path, body);
  console.log(
    `Stored review guidelines (${body.length} chars, from ${source}) at ${path}`,
  );
  return { source, body, path };
}

/**
 * Reload guidelines that Pass 1 stored, for the Pass 2 prompt. Returns
 * undefined when Pass 1 found none or the copy has gone missing.
 */
export async function loadStoredReviewGuidelines(
  stored: StoredReviewGuidelines | null | undefined,
): Promise<RepoReviewGuidelines | undefined> {
  if (!stored) {
    return undefined;
  }
  try {
    const body = await readFile(stored.path, "utf8");
    return body ? { ...stored, body } : undefined;
  } catch (error) {
    console.warn(
      `Could not reload review guidelines from ${stored.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}
