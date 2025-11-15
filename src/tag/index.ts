import { checkContainsTrigger } from "../github/validation/trigger";
import { checkHumanActor } from "../github/validation/actor";
import { createInitialComment } from "../github/operations/comments/create-initial";
import { extractTriggerTimestamp } from "../github/data/fetcher";
import { isEntityContext } from "../github/context";
import { extractCommandFromContext } from "../github/utils/command-parser";
import { prepareFillMode } from "./commands/fill";
import { prepareReviewMode } from "./commands/review";
import type { GitHubContext } from "../github/context";
import type { PrepareResult } from "../prepare/types";
import type { Octokits } from "../github/api/client";

export function shouldTriggerTag(context: GitHubContext): boolean {
  if (!isEntityContext(context)) {
    return false;
  }
  if (context.inputs.automaticReview) {
    return context.isPR;
  }
  return checkContainsTrigger(context);
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
  const triggerTime = extractTriggerTimestamp(context);

  if (context.inputs.automaticReview && !context.isPR) {
    throw new Error("automatic_review requires a pull request context");
  }

  const commandContext = extractCommandFromContext(context);

  if (context.inputs.automaticReview) {
    return prepareReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
      triggerTime,
    });
  }

  if (commandContext?.command === "fill") {
    return prepareFillMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
      triggerTime,
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
      triggerTime,
    });
  }

  throw new Error(`Unexpected command: ${commandContext?.command}`);
}
