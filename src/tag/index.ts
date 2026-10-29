import * as core from "@actions/core";
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
import { isAutomationContext } from "../github/context";
import { prepareStewardMode } from "../steward";
import { DroidRunType, resolveTagRunType, setDroidRunType } from "../run-type";
import { DROID_APP_BOT_ID } from "../github/bot-identity";
import { prepareConversationCommand } from "./commands/conversation";
import { hasSummaryMarker } from "../core/review/markers";
const SECURITY_REVIEW_MARKER = "## Security Review Summary";

export function shouldTriggerTag(context: GitHubContext): boolean {
  if (isAutomationContext(context)) {
    return (
      context.eventName === "workflow_run" &&
      (context.inputs.ciSteward ?? false)
    );
  }
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

    let viewer: string | undefined;
    try {
      viewer = (
        await octokit.graphql<{ viewer: { login: string } }>(
          "query DroidSecurityViewer { viewer { login } }",
        )
      ).viewer.login;
    } catch {
      /* The known Droid App id remains a safe identity fallback. */
    }
    const hasSecurityReview = comments.data.some((comment) => {
      const isOurBot =
        comment.user?.id === DROID_APP_BOT_ID ||
        (!!viewer && comment.user?.login === viewer);
      const body = comment.body ?? "";
      return (
        isOurBot &&
        (body.includes(SECURITY_REVIEW_MARKER) ||
          (hasSummaryMarker(body) && body.includes("Security review: ran")))
      );
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
  if (isAutomationContext(context)) {
    const runType = DroidRunType.CiSteward;
    setDroidRunType(runType);
    return prepareStewardMode(context, octokit, githubToken, runType);
  }
  if (!isEntityContext(context)) {
    throw new Error("Tag execution requires entity context");
  }

  await checkHumanActor(octokit.rest, context);

  if (context.inputs.automaticReview && !context.isPR) {
    throw new Error("automatic_review requires a pull request context");
  }

  if (context.inputs.automaticSecurityReview && !context.isPR) {
    throw new Error(
      "automatic_security_review requires a pull request context",
    );
  }

  let commandContext = extractCommandFromContext(context);
  if (
    commandContext?.location === "body" &&
    (context.inputs.automaticReview || context.inputs.automaticSecurityReview)
  ) {
    commandContext = null;
  }
  // Explicit comment commands take precedence over automatic-review flags.
  if (commandContext && commandContext.location === "comment") {
    context = {
      ...context,
      inputs: {
        ...context.inputs,
        automaticReview: false,
        automaticSecurityReview: false,
      },
    };
  }
  const runType = resolveTagRunType({
    automaticReview: context.inputs.automaticReview,
    automaticSecurityReview: context.inputs.automaticSecurityReview,
    command: commandContext?.command ?? null,
  });
  if (runType) {
    setDroidRunType(runType);
  }
  if (
    commandContext &&
    [
      "help",
      "unknown",
      "question",
      "fix",
      "resolve",
      "pause",
      "resume",
    ].includes(commandContext.command)
  ) {
    return prepareConversationCommand({
      context,
      octokit,
      command: commandContext,
    });
  }

  let runAutomaticSecurityReview = context.inputs.automaticSecurityReview;
  if (runAutomaticSecurityReview) {
    const hasExisting = await hasExistingSecurityReview(octokit, context);
    if (hasExisting) {
      console.log(
        "Security review already exists on this PR, skipping security",
      );
      runAutomaticSecurityReview = false;

      if (!context.inputs.automaticReview) {
        core.setOutput("run_code_review", "false");
        core.setOutput("run_security_review", "false");
        return prepareSecurityReviewMode({
          context,
          octokit,
          githubToken,
          runType,
          skipReason: "Security review already exists on this PR.",
        });
      }
    }
  }

  // Determine comment type based on what's being run
  const isDualReview =
    context.inputs.automaticReview && runAutomaticSecurityReview;
  const isSecurityOnly =
    !context.inputs.automaticReview &&
    (runAutomaticSecurityReview ||
      commandContext?.command === "security" ||
      commandContext?.command === "security-full");

  const commentType = isDualReview
    ? "review_and_security"
    : isSecurityOnly
      ? "security"
      : "default";

  const isReviewRun =
    runType === null ||
    runType === DroidRunType.Review ||
    runType === DroidRunType.Default ||
    runType === DroidRunType.SecurityReview;
  const commentData = isReviewRun
    ? undefined
    : await createInitialComment(octokit.rest, context, commentType, runType);
  const commentId = commentData?.id;

  // Handle when both automatic review flags are set
  if (
    context.inputs.automaticReview &&
    context.inputs.automaticSecurityReview
  ) {
    if (runAutomaticSecurityReview) {
      // Signal to the code review prompt to spawn a security-reviewer subagent
      core.exportVariable("SECURITY_REVIEW_ENABLED", "true");
      core.setOutput("install_security_skills", "true");
    }

    core.setOutput("run_code_review", "true");
    core.setOutput(
      "run_security_review",
      runAutomaticSecurityReview.toString(),
    );

    // Prepare the code review (security review runs as a subagent within pass 1)
    return prepareReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
      runType,
      fullReview: commandContext?.fullReview,
      focus: commandContext?.focus,
    });
  }

  if (context.inputs.automaticReview) {
    core.setOutput("run_code_review", "true");
    core.setOutput("run_security_review", "false");
    return prepareReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
      runType,
      fullReview: commandContext?.fullReview,
      focus: commandContext?.focus,
    });
  }

  if (context.inputs.automaticSecurityReview) {
    // Standalone security review uses the two-pass pipeline (candidates + validator)
    core.setOutput("run_code_review", "true");
    core.setOutput("run_security_review", "true");
    return prepareSecurityReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
      runType,
    });
  }

  if (commandContext?.command === "fill") {
    return prepareFillMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
      runType,
    });
  }

  if (commandContext?.command === "security") {
    // Standalone security review uses the two-pass pipeline (candidates + validator)
    core.setOutput("run_code_review", "true");
    core.setOutput("run_security_review", "true");
    return prepareSecurityReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
      runType,
    });
  }

  if (commandContext?.command === "security-full") {
    return prepareSecurityScanMode({
      context,
      octokit,
      githubToken,
      scanScope: { type: "full" },
      runType,
    });
  }

  // @droid review or @droid (default) = code review only
  if (
    commandContext?.command === "review" ||
    !commandContext ||
    commandContext.command === "default"
  ) {
    core.setOutput("run_code_review", "true");
    core.setOutput("run_security_review", "false");
    return prepareReviewMode({
      context,
      octokit,
      githubToken,
      trackingCommentId: commentId,
      runType,
      fullReview: commandContext?.fullReview,
      focus: commandContext?.focus,
    });
  }

  throw new Error(`Unexpected command: ${commandContext?.command}`);
}
