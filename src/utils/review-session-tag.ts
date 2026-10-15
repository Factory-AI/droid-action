import { quote as quoteShellArgs } from "shell-quote";
import { DroidRunType } from "../run-type";

/**
 * Every `droid exec` in the review pipeline has carried a bare
 * `--tag code-review`. The name stays the same so anything filtering on it
 * keeps working; the metadata below is what lets the warehouse identify a
 * review session and join the passes of one run without matching prompt text.
 */
export const REVIEW_SESSION_TAG_NAME = "code-review";

export type ReviewPass = "candidates" | "validator";
export type ReviewType = "code" | "security";
export type ReviewPlatform = "github" | "gitlab";
/** The CLI records this as the usage event's product. */
export type ReviewProduct = "code_review" | "security_review";

/**
 * Every value is a string: `droid exec` validates `--tag` metadata as a
 * string-to-string record and refuses to start on anything else, booleans
 * included.
 */
export type ReviewSessionTagMetadata = {
  pass: ReviewPass;
  reviewType: ReviewType;
  product: ReviewProduct;
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

export function reviewTypeForRunType(
  runType: DroidRunType | null | undefined,
): ReviewType {
  return runType === DroidRunType.SecurityReview ? "security" : "code";
}

export function buildReviewSessionTag(
  input: ReviewSessionTagInput,
): ReviewSessionTag {
  const metadata: ReviewSessionTagMetadata = {
    pass: input.pass,
    reviewType: input.reviewType,
    product:
      input.reviewType === "security" ? "security_review" : "code_review",
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

/**
 * Renders the tag as a `--tag <json>` fragment for a `droid_args` string.
 * `droid_args` is split with shell-quote's `parse` before it reaches the CLI,
 * so quoting with the same library guarantees the JSON survives as one token.
 */
export function formatSessionTagArg(tag: {
  name: string;
  metadata: object;
}): string {
  return `--tag ${quoteShellArgs([JSON.stringify(tag)])}`;
}

/**
 * The `--tag` fragment for a GitHub Actions review pass. The run attempt and
 * the security review flag are not part of the parsed context, so they
 * are read from the runner environment. SECURITY_REVIEW_ENABLED is the same
 * variable the prompt templates read, and it reaches the validator step
 * through GITHUB_ENV, so both passes of a run agree with the prompt.
 */
export function githubReviewSessionTagArg(input: {
  pass: ReviewPass;
  runType: DroidRunType | null | undefined;
  context: {
    runId: string;
    repository: { owner: string; repo: string };
    entityNumber: number;
  };
}): string {
  return formatSessionTagArg(
    buildReviewSessionTag({
      pass: input.pass,
      reviewType: reviewTypeForRunType(input.runType),
      platform: "github",
      repo: `${input.context.repository.owner}/${input.context.repository.repo}`,
      pr: input.context.entityNumber,
      securityReview: process.env.SECURITY_REVIEW_ENABLED === "true",
      runId: input.context.runId,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    }),
  );
}
