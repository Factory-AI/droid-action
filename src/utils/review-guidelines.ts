import { readFile } from "fs/promises";
import { resolve } from "path";

const REVIEW_GUIDELINES_PATH = ".factory/skills/review-guidelines.md";

export async function loadReviewGuidelines(): Promise<string | undefined> {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const filePath = resolve(workspace, REVIEW_GUIDELINES_PATH);

  try {
    const content = await readFile(filePath, "utf8");
    const trimmed = content.trim();
    if (!trimmed) return undefined;
    console.log(
      `Loaded review guidelines from ${REVIEW_GUIDELINES_PATH} (${trimmed.length} bytes)`,
    );
    return trimmed;
  } catch {
    return undefined;
  }
}
