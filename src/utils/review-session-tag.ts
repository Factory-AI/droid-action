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

export type ReviewSessionTagMetadata = {
  pass: ReviewPass;
  reviewType: ReviewType;
  platform: ReviewPlatform;
  /** `owner/repo` on GitHub, `group/project` on GitLab. */
  repo: string;
  /** PR number on GitHub, MR iid on GitLab. */
  pr: string;
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
    platform: input.platform,
    repo: input.repo,
    pr: String(input.pr),
  };
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
export function formatReviewSessionTagArg(tag: ReviewSessionTag): string {
  return `--tag ${quoteShellArgs([JSON.stringify(tag)])}`;
}

/**
 * The `--tag` fragment for a GitHub Actions review pass. The run attempt is
 * not part of the parsed context, so it is read from the runner environment.
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
  return formatReviewSessionTagArg(
    buildReviewSessionTag({
      pass: input.pass,
      reviewType: reviewTypeForRunType(input.runType),
      platform: "github",
      repo: `${input.context.repository.owner}/${input.context.repository.repo}`,
      pr: input.context.entityNumber,
      runId: input.context.runId,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    }),
  );
}
