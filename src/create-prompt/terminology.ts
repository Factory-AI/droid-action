import type { ReviewTerminology } from "../core/review/prompts/types";

export const GITHUB_TERMINOLOGY: ReviewTerminology = {
  entityNoun: "PR",
  entityNumberSigil: "#",
  platformName: "GitHub",
  repoLabel: "Repo",
  entityNumberLabel: "PR Number",
  headRefLabel: "PR Head Ref",
  headShaLabel: "PR Head SHA",
  baseRefLabel: "PR Base Ref",
  baseRefShortLabel: "base ref",
  descriptionLabel: "PR Description",
  diffLabel: "Full PR Diff",
  metaRepoKey: "repo",
  metaEntityNumberKey: "prNumber",
  metaBaseRefKey: "baseRef",
  repoExample: "owner/repo",
  pathFieldDescription: 'Relative file path (e.g., "src/index.ts")',
  lineFieldDescription:
    "Target line number (single-line) or end line number (multi-line). Must be a positive integer. " +
    "Must be a line that appears in the PR diff; GitHub rejects inline comments on lines " +
    "outside the diff, so a finding about untouched code should anchor to the nearest " +
    "related changed line instead.",
  mutationToolForbiddance:
    "(inline comments, submit review, delete/minimize/reply/resolve, etc.)",
  trackingCommentName: "tracking comment",
  // No security-badge instruction on GitHub today; left undefined intentionally.
};
