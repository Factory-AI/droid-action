/**
 * Every `droid exec` in the review pipeline has carried a bare
 * `--tag code-review`. The name stays the same so anything filtering on it
 * keeps working; the metadata below is what lets the warehouse identify a
 * review session and join the passes of one run without matching prompt text.
 */
export const REVIEW_SESSION_TAG_NAME = "code-review";

export type ReviewPass = "candidates" | "validator";
export type ReviewType = "code" | "security";
export type ReviewPlatform = "github" | "gitlab" | "bitbucket" | "azure-devops";

/**
 * Every value is a string: `droid exec` validates `--tag` metadata as a
 * string-to-string record and refuses to start on anything else, booleans
 * included.
 */
export type ReviewSessionTagMetadata = {
  pass: ReviewPass;
  reviewType: ReviewType;
  platform: ReviewPlatform;
  /** `owner/repo` on GitHub, `group/project` on GitLab. */
  repo: string;
  /** PR number on GitHub, MR iid on GitLab. */
  pr: string;
  /**
   * Code reviews only, on both passes: "true" when the candidates pass
   * spawns the `security-reviewer` subagent. That subagent's session carries
   * only the CLI's `subagent` tag, so this is the run-level record that part
   * of the review's spend is security work. Absent when `reviewType` is
   * "security".
   */
  securityReview?: "true" | "false";
  /** `GITHUB_RUN_ID` / `CI_JOB_ID`; shared by both passes of one run. */
  runId?: string;
  /** `GITHUB_RUN_ATTEMPT`; re-runs of the same run id get distinct sessions. */
  runAttempt?: string;
};

export type ReviewSessionTag = {
  name: typeof REVIEW_SESSION_TAG_NAME;
  metadata: ReviewSessionTagMetadata;
};

export type ReviewSessionTagInput = {
  pass: ReviewPass;
  reviewType: ReviewType;
  platform: ReviewPlatform;
  repo: string;
  pr: number | string;
  securityReview: boolean;
  runId?: string | null;
  runAttempt?: string | null;
};

export function buildReviewSessionTag(
  input: ReviewSessionTagInput,
): ReviewSessionTag {
  const metadata: ReviewSessionTagMetadata = {
    pass: input.pass,
    reviewType: input.reviewType,
    platform: input.platform,
    repo: input.repo,
    pr: String(input.pr),
  };
  if (input.reviewType === "code") {
    metadata.securityReview = input.securityReview ? "true" : "false";
  }
  if (input.runId) {
    metadata.runId = input.runId;
  }
  if (input.runAttempt) {
    metadata.runAttempt = input.runAttempt;
  }
  return { name: REVIEW_SESSION_TAG_NAME, metadata };
}
