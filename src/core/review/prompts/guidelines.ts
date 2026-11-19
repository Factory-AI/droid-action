/**
 * Repository review guidelines, injected verbatim into the Pass 1 and
 * Pass 2 prompts.
 *
 * A repository can ship its own review guidelines as a
 * `review-guidelines` skill. Leaving it to the model to notice and
 * invoke that skill proved unreliable, so the pipeline reads the file
 * itself and places its text in the prompt. The model then has the
 * guidelines before it reads the diff, every run, with no tool call
 * in between.
 */

import type { RepoReviewGuidelines } from "./types";
import type { ReviewPass } from "../../../utils/review-session-tag";

/** Repository-relative location of the review guidelines skill. */
export const REVIEW_GUIDELINES_SKILL_PATH =
  ".factory/skills/review-guidelines/SKILL.md";

/**
 * Guidelines larger than this are not inlined; the prompt points at the
 * on-disk copy instead so one oversized file cannot crowd out the rest
 * of the prompt.
 */
export const INLINE_GUIDELINES_MAX_BYTES = 32 * 1024;

/**
 * Drop the skill's YAML frontmatter (`name`, `description`, ...), which
 * exists for skill discovery and is noise once the text is in a prompt.
 */
export function stripSkillFrontmatter(markdown: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
  return (match ? markdown.slice(match[0].length) : markdown).trim();
}

function guidelinesText(
  guidelines: RepoReviewGuidelines,
  pass: ReviewPass,
): string {
  if (
    Buffer.byteLength(guidelines.body, "utf8") <= INLINE_GUIDELINES_MAX_BYTES
  ) {
    const subagentNote =
      pass === "candidates"
        ? " If you spawn subagents to review the change, copy the `<review-guidelines>` block below verbatim into each subagent's prompt."
        : "";
    return `The full text is reproduced below, so do not invoke the \`review-guidelines\` skill to load it again.${subagentNote}

<review-guidelines source="${guidelines.source}">
${guidelines.body}
</review-guidelines>`;
  }
  const subagentNote =
    pass === "candidates"
      ? " If you spawn subagents to review the change, instruct each one to read that file in full before reviewing."
      : "";
  return `The full text is too long to repeat here; it is stored at \`${guidelines.path}\`. Read that file in full before you start, and do not invoke the \`review-guidelines\` skill to load it again.${subagentNote}`;
}

/**
 * `@droid review /<name>` asks for the review to follow one of the
 * repository's skills. Only a plain directory name is accepted, and plugin
 * directory names must pass the same check, so a lookup can never leave the
 * skill roots below.
 */
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isReviewSkillName(name: string): boolean {
  return SKILL_NAME.test(name);
}

export function parseReviewSkillTag(
  focus: string | undefined,
): string | undefined {
  const tag = focus?.trim() ?? "";
  return tag.startsWith("/") && isReviewSkillName(tag.slice(1))
    ? tag.slice(1)
    : undefined;
}

/** Searched first. */
export const REVIEW_SKILL_DIR = ".factory/skills";
/** Then every `<plugin>/skills/` under this directory. */
export const REVIEW_SKILL_PLUGIN_DIR = ".factory/factory-mono-plugins/plugins";
export const REVIEW_SKILL_ROOTS_DESCRIPTION = `\`${REVIEW_SKILL_DIR}/\` or \`${REVIEW_SKILL_PLUGIN_DIR}/*/skills/\``;

export function reviewSkillPath(skillsDir: string, name: string): string {
  return `${skillsDir}/${name}/SKILL.md`;
}

/** Pass 1 section for a skill the user named with `@droid review /<name>`. */
export function buildRequestedReviewSkillSection(
  name: string,
  skill: RepoReviewGuidelines,
): string {
  const text =
    Buffer.byteLength(skill.body, "utf8") <= INLINE_GUIDELINES_MAX_BYTES
      ? `<review-skill name="${name}" source="${skill.source}">
${skill.body}
</review-skill>`
      : `The full text is too long to repeat here; it is stored at \`${skill.path}\`. Read that file in full before you start.`;
  return `## Requested review skill

The user asked for this review to follow the repository's \`${name}\` skill, read from \`${skill.source}\`. Still run the \`review\` skill's Pass 1 procedure, but take what to look for, where to look, and how deep to go from the skill below; where the two disagree on what to flag, follow the skill below. It does not change this run's mechanics: the output file, its schema, the tool restrictions, and the posting rules in this prompt still apply exactly as written. Do not invoke the \`${name}\` skill to load it again. If you spawn subagents to review the change, give each one this section verbatim.

${text}`;
}

/**
 * Prompt section carrying the repository's review guidelines. Returns
 * undefined when the repository has none, so callers can splice it in
 * conditionally.
 */
export function buildRepoGuidelinesSection(
  guidelines: RepoReviewGuidelines | undefined,
  pass: ReviewPass,
): string | undefined {
  if (!guidelines) {
    return undefined;
  }
  const application =
    pass === "candidates"
      ? "Apply it on top of the review skill's methodology when deciding what to flag, how to rank severity, what to leave alone, and how to word findings."
      : "Apply it when judging each candidate: whether it is worth posting under these guidelines, which severity tag it deserves, and how it is worded.";
  return `## Repository review guidelines

This repository defines its own review guidelines in \`${guidelines.source}\`. ${application} It does not change this run's mechanics: the output file, its schema, the tool restrictions, and the posting rules in this prompt still apply exactly as written.

${guidelinesText(guidelines, pass)}`;
}
