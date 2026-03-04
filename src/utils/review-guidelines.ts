import { readFile } from "fs/promises";
import { resolve } from "path";

export const REVIEW_GUIDELINES_PATH =
  ".factory/skills/review-guidelines/SKILL.md";
export const MAX_GUIDELINES_SIZE = 80_000;
const MIN_TRUNCATED_CONTENT_CHARS = 200;

export async function loadReviewGuidelines(): Promise<string | undefined> {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const filePath = resolve(workspace, REVIEW_GUIDELINES_PATH);

  try {
    const content = await readFile(filePath, "utf8");
    const trimmed = content.trim();
    if (!trimmed) return undefined;

    if (trimmed.length > MAX_GUIDELINES_SIZE) {
      const truncationMarker = `\n\n... [truncated - guidelines exceed ${MAX_GUIDELINES_SIZE} character limit. Use your tools to read the full file at ${REVIEW_GUIDELINES_PATH}]`;
      const availableSpace = MAX_GUIDELINES_SIZE - truncationMarker.length;

      console.warn(
        `Review guidelines exceed ${MAX_GUIDELINES_SIZE} character limit (${trimmed.length} chars), truncating`,
      );

      if (availableSpace > MIN_TRUNCATED_CONTENT_CHARS) {
        return trimmed.slice(0, availableSpace) + truncationMarker;
      }

      return truncationMarker.trim();
    }

    console.log(
      `Loaded review guidelines from ${REVIEW_GUIDELINES_PATH} (${trimmed.length} bytes)`,
    );
    return trimmed;
  } catch {
    return undefined;
  }
}

export function formatGuidelinesSection(
  guidelines: string | undefined,
): string {
  if (!guidelines) return "";
  return `
<custom_review_guidelines>
The repository maintainers have provided the following review guidelines under \`.factory/skills/review-guidelines/SKILL.md\`. You MUST follow these in addition to the standard review procedure:

${guidelines}
</custom_review_guidelines>
`;
}
