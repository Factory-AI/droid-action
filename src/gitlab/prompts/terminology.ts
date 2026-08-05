import type { ReviewTerminology } from "../../core/review/prompts/types";

/**
 * GitLab runs the review with `postingMode: "file"`: the agent never holds
 * an MR-mutation tool, so this terminology deliberately omits the
 * submit-review / tracking-tool names that only apply to the MCP posting
 * mode. `src/entrypoints/gitlab-post-review.ts` does the posting, and
 * `src/entrypoints/gitlab-update-comment-link.ts` renders the tracking
 * note (security badge included).
 */
export const GITLAB_TERMINOLOGY: ReviewTerminology = {
  entityNoun: "MR",
  entityNumberSigil: "!",
  platformName: "GitLab",
  repoLabel: "Project",
  entityNumberLabel: "MR IID",
  headRefLabel: "MR Source Branch",
  headShaLabel: "MR Head SHA",
  baseRefLabel: "MR Target Branch",
  baseRefShortLabel: "target branch",
  descriptionLabel: "MR Description",
  diffLabel: "Full MR Diff",
  metaRepoKey: "project",
  metaEntityNumberKey: "mrIid",
  metaBaseRefKey: "targetBranch",
  repoExample: "group/project",
  pathFieldDescription:
    'Relative file path (use the new_path from the diff, e.g., "src/index.ts")',
  lineFieldDescription:
    "Target line number in the new file (single-line) or end line number (multi-line). Must be ≥ 0.",
  mutationToolForbiddance:
    "(no MR notes, discussions, description edits, approvals, or label changes — " +
    "whether through an MCP tool, the GitLab REST API, `glab`, or `curl`)",
  trackingCommentName: "sticky tracking note",
};
