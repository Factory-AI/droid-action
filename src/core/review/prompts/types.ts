/**
 * Shared types for the platform-agnostic review prompts.
 *
 * The candidate-generation (Pass 1) and validator (Pass 2) prompts are
 * structurally identical between GitHub and GitLab. The only things that
 * vary are labels, identifier names, MCP tool names, and a small number
 * of platform-specific instruction lines. Those variations are captured
 * here so the shared templates can stay platform-agnostic.
 */

export interface ReviewTerminology {
  /** "PR" or "MR" */
  entityNoun: string;
  /** "#" for GitHub PRs, "!" for GitLab MRs */
  entityNumberSigil: string;
  /** "GitHub" or "GitLab" */
  platformName: string;
  /** Label for the repo/project value (e.g. "Repo" or "Project") */
  repoLabel: string;
  /** Label for the entity number row in <context> (e.g. "PR Number" or "MR IID") */
  entityNumberLabel: string;
  /** Label for the source branch row (e.g. "PR Head Ref" or "MR Source Branch") */
  headRefLabel: string;
  /** Label for the head SHA row (e.g. "PR Head SHA" or "MR Head SHA") */
  headShaLabel: string;
  /** Label for the target branch row (e.g. "PR Base Ref" or "MR Target Branch") */
  baseRefLabel: string;
  /** Short form of the target-branch concept, used in narrative prose (e.g. "base ref" or "target branch") */
  baseRefShortLabel: string;
  /** Label for the description artifact (e.g. "PR Description" or "MR Description") */
  descriptionLabel: string;
  /** Label for the diff artifact (e.g. "Full PR Diff" or "Full MR Diff") */
  diffLabel: string;
  /** JSON meta key for the repo identifier (e.g. "repo" or "project") */
  metaRepoKey: string;
  /** JSON meta key for the entity number (e.g. "prNumber" or "mrIid") */
  metaEntityNumberKey: string;
  /** JSON meta key for the base ref (e.g. "baseRef" or "targetBranch") */
  metaBaseRefKey: string;
  /** Example identifier in schema doc (e.g. "owner/repo" or "group/project") */
  repoExample: string;
  /** Free-form description for the `path` field (small wording variation) */
  pathFieldDescription: string;
  /** Free-form description for the `line` field (small wording variation) */
  lineFieldDescription: string;
  /** Free-form blurb listing mutation tools/APIs the candidates pass MUST NOT use */
  mutationToolForbiddance: string;

  // The fields below only apply to `postingMode: "tool"` (the agent posts
  // its own findings through MCP). Platforms that post from CI instead
  // (see `postingMode: "file"`) leave them undefined.

  /** MCP tool name for posting a batched review (Pass 2) */
  submitReviewToolName?: string;
  /** Extra args appended to the submit_review instruction (e.g. " along with `mr_iid: 5`") */
  submitReviewExtraArg?: string;
  /** Trailing clause on the "Do NOT include a body parameter" line */
  submitReviewBodyExclusionTrailer?: string;
  /** MCP tool name for updating the sticky tracking comment/note */
  updateTrackingToolName?: string;
  /** Human-readable name for the sticky comment (e.g. "tracking comment" or "sticky tracking note") */
  trackingCommentName?: string;
  /** "comment" (GH) or "top-level note" (GL), used in "post the summary as a separate X" */
  summaryEntityName?: string;
  /** Trailing clause on the summary-forbiddance line (e.g. " or as the body of `submit_review`" on GH; "" on GL) */
  summaryPostingExtraExclusion?: string;
  /** Approval/changes line at the end of validator instructions */
  approvalChangesNote?: string;
}

/**
 * Who turns approved findings into review comments.
 *
 * - "tool": the agent calls the platform's MCP submit-review tool itself.
 * - "file": the validated JSON on disk is the deliverable, and a CI step
 *   posts it through the platform API afterwards.
 */
export type ReviewPostingMode = "tool" | "file";

export interface ReviewPromptContext {
  terminology: ReviewTerminology;
  /** PR number / MR IID */
  entityNumber: number | string;
  /** Full repo/project identifier */
  repoOrProject: string;
  /** Source branch name */
  headRef: string;
  /** Head SHA */
  headSha: string;
  /** Target branch name */
  baseRef: string;
  /** On-disk path to the diff artifact */
  diffPath: string;
  /** On-disk path to existing-comments JSON */
  commentsPath: string;
  /** On-disk path to description text */
  descriptionPath: string;
  /** On-disk path where Pass 1 writes the candidates JSON */
  candidatesPath: string;
  /** On-disk path where Pass 2 writes the validated JSON (validator only) */
  validatedPath?: string;
  /** How approved findings get posted (validator only). Defaults to "tool". */
  postingMode?: ReviewPostingMode;
  includeSuggestions: boolean;
  /** Spawn security-reviewer subagent during Pass 1 (candidates only) */
  securityReviewEnabled: boolean;
}
