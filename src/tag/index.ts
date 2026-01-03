import { checkContainsTrigger } from "../github/validation/trigger";
import { checkHumanActor } from "../github/validation/actor";
import { createInitialComment } from "../github/operations/comments/create-initial";
import { isEntityContext, type ParsedGitHubContext } from "../github/context";
import { extractCommandFromContext } from "../github/utils/command-parser";
import { prepareFillMode } from "./commands/fill";
import { prepareReviewMode } from "./commands/review";
import { prepareSecurityReviewMode } from "./commands/security-review";
import { prepareSecurityScanMode } from "./commands/security-scan";
import type { GitHubContext } from "../github/context";
import type { PrepareResult } from "../prepare/types";
import type { Octokits } from "../github/api/client";

const DROID_APP_BOT_ID = 209825114;
const SECURITY_REVIEW_MARKER = "## Security Review Summary";

export function shouldTriggerTag(context: GitHubContext): boolean {
  if (!isEntityContext(context)) {
    return false;
  }
  if (
    context.inputs.automaticReview ||
    context.inputs.automaticSecurityReview
  ) {
    return context.isPR;
  }
  return checkContainsTrigger(context);
}

/**
 * Checks if a security review has already been performed on this PR.
 * Used to implement "run once" behavior for automatic security reviews.
 */
async function hasExistingSecurityReview(
  octokit: Octokits,
  context: ParsedGitHubContext,
): Promise<boolean> {
  const { owner, repo } = context.repository;

  try {
    const comments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: context.entityNumber,
      per_page: 100,
    });

    const hasSecurityReview = comments.data.some((comment) => {
      const isOurBot =
        comment.user?.id === DROID_APP_BOT_ID ||
        (comment.user?.type === "Bot" &&
          comment.user?.login.toLowerCase().includes("droid"));
      return isOurBot && comment.body?.includes(SECURITY_REVIEW_MARKER);
    });

    return hasSecurityReview;
  } catch (error) {
    console.warn("Failed to check for existing security review:", error);
    return false;
  }
}

type PrepareTagOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
};

export async function prepareTagExecution({
  context,
  octokit,
  githubToken,
}: PrepareTagOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("Tag execution requires entity context");
  }

  await checkHumanActor(octokit.rest, context);

  const commentData = await createInitialComment(octokit.rest, context);
  const commentId = commentData.id;

  if (
    context.inputs.automaticReview &&
    context.inputs.automaticSecurityReview
  ) {
    throw new Error(
      "automatic_review and automatic_security_review cannot both be true",
    );
  }

  if (context.inputs.automaticReview && !context.isPR) {
    throw new Error("automatic_review requires a pull request context");
  }

  if (context.inputs.automaticSecurityReview && !context.isPR) {
    throw new Error(
      "automatic_security_review requires a pull request context",
    );
  }

  const commandContext = extractCommandFromContext(context);

  if (context.inputs.automaticReview) {
    return prepareReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (context.inputs.automaticSecurityReview) {
    // Check if security review already exists on this PR (run once behavior)
    const hasExisting = await hasExistingSecurityReview(octokit, context);
    if (hasExisting) {
      console.log("Security review already exists on this PR, skipping");
      return {
        skipped: true,
        reason: "security_review_exists",
        branchInfo: {
          baseBranch: "",
          currentBranch: "",
        },
        mcpTools: "",
      };
    }

    return prepareSecurityReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (commandContext?.command === "fill") {
    return prepareFillMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (commandContext?.command === "security") {
    return prepareSecurityReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  if (commandContext?.command === "security-full") {
    return prepareSecurityScanMode({
      context,
      octokit,
      githubToken,
      scanScope: { type: "full" },
    });
  }

  if (
    commandContext?.command === "review" ||
    !commandContext ||
    commandContext.command === "default"
  ) {
    return prepareReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
    });
  }

  throw new Error(`Unexpected command: ${commandContext?.command}`);
}
