#!/usr/bin/env bun

import * as core from "@actions/core";
import { writeFile, mkdir } from "fs/promises";
import type {
  IssuesEvent,
  IssuesAssignedEvent,
  IssuesLabeledEvent,
} from "@octokit/webhooks-types";
import {
  isIssuesEvent,
  isIssueCommentEvent,
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
} from "../github/context";
import type { ParsedGitHubContext } from "../github/context";
import type { CommonFields, PreparedContext, EventData } from "./types";

export type { CommonFields, PreparedContext } from "./types";

const BASE_ALLOWED_TOOLS = [
  "Execute",
  "Edit",
  "Create",
  "Read",
  "Glob",
  "Grep",
  "LS",
];

export function buildAllowedToolsString(
  customAllowedTools: string[] = [],
  includeActionsTools: boolean = false,
): string {
  const tools = new Set<string>(BASE_ALLOWED_TOOLS);
  tools.add("github_comment___update_droid_comment");

  if (includeActionsTools) {
    tools.add("github_ci___get_ci_status");
    tools.add("github_ci___get_workflow_run_details");
    tools.add("github_ci___download_job_log");
  }

  for (const tool of customAllowedTools) {
    if (tool) {
      tools.add(tool);
    }
  }

  return Array.from(tools).join(",");
}

export function buildDisallowedToolsString(
  customDisallowedTools: string[] = [],
  allowedTools: string[] = [],
): string {
  const baseDisallowed = ["WebSearch", "FetchUrl"];
  const allowedSet = new Set(allowedTools);

  const filtered = baseDisallowed.filter((tool) => !allowedSet.has(tool));
  const combined = [...filtered, ...customDisallowedTools].filter(Boolean);

  return combined.join(",");
}

export function prepareContext(
  context: ParsedGitHubContext,
  droidCommentId: string,
  baseBranch?: string,
  droidBranch?: string,
  prBranchData?: { headRefName: string; headRefOid: string },
): PreparedContext {
  const repository = context.repository.full_name;
  const triggerPhrase = context.inputs.triggerPhrase || "@droid";

  const commonFields: CommonFields = {
    repository,
    droidCommentId,
    triggerPhrase,
  };

  let triggerUsername: string | undefined;
  let commentId: string | undefined;
  let commentBody: string | undefined;

  if (isIssueCommentEvent(context)) {
    commentId = context.payload.comment.id?.toString();
    commentBody = context.payload.comment.body || "";
    triggerUsername = context.payload.comment.user?.login;
  } else if (isPullRequestReviewCommentEvent(context)) {
    commentId = context.payload.comment.id?.toString();
    commentBody = context.payload.comment.body || "";
    triggerUsername = context.payload.comment.user?.login;
  } else if (isPullRequestReviewEvent(context)) {
    commentBody = context.payload.review.body || "";
    triggerUsername = context.payload.review.user?.login;
  } else if (isIssuesEvent(context)) {
    triggerUsername = context.payload.issue?.user?.login;
  } else if (isPullRequestEvent(context)) {
    triggerUsername = context.payload.pull_request?.user?.login;
  }

  if (triggerUsername) {
    commonFields.triggerUsername = triggerUsername;
  }
  if (droidBranch) {
    commonFields.droidBranch = droidBranch;
  }

  const eventData = buildEventData(context, {
    commentId,
    commentBody,
    baseBranch,
    droidBranch,
  });

  const result: PreparedContext = {
    ...commonFields,
    eventData,
    githubContext: context,
  };

  if (prBranchData) {
    result.prBranchData = prBranchData;
  }

  return result;
}

type EventBuilderExtras = {
  commentId?: string;
  commentBody?: string;
  baseBranch?: string;
  droidBranch?: string;
};

function buildEventData(
  context: ParsedGitHubContext,
  extras: EventBuilderExtras,
): EventData {
  const { commentId, commentBody, baseBranch, droidBranch } = extras;

  const entityNumber = context.entityNumber?.toString();

  switch (context.eventName) {
    case "pull_request_review_comment":
      if (!context.isPR || !entityNumber) {
        throw new Error("pull_request_review_comment requires PR context");
      }
      if (!commentBody) {
        throw new Error("Missing comment body for pull_request_review_comment");
      }
      return {
        eventName: "pull_request_review_comment",
        isPR: true,
        prNumber: entityNumber,
        ...(commentId && { commentId }),
        commentBody,
        ...(droidBranch && { droidBranch }),
        ...(baseBranch && { baseBranch }),
      };

    case "pull_request_review":
      if (!context.isPR || !entityNumber) {
        throw new Error("pull_request_review requires PR context");
      }
      if (!commentBody) {
        throw new Error("Missing review body for pull_request_review event");
      }
      return {
        eventName: "pull_request_review",
        isPR: true,
        prNumber: entityNumber,
        commentBody,
        ...(droidBranch && { droidBranch }),
        ...(baseBranch && { baseBranch }),
      };

    case "issue_comment":
      if (!commentId || !commentBody) {
        throw new Error("issue_comment requires comment id and body");
      }
      if (context.isPR) {
        if (!entityNumber) {
          throw new Error("issue_comment on PR requires PR number");
        }
        return {
          eventName: "issue_comment",
          commentId,
          isPR: true,
          prNumber: entityNumber,
          commentBody,
          ...(droidBranch && { droidBranch }),
          ...(baseBranch && { baseBranch }),
        };
      }
      if (!droidBranch || !baseBranch) {
        throw new Error(
          "issue_comment on issues requires droidBranch and baseBranch",
        );
      }
      return {
        eventName: "issue_comment",
        commentId,
        isPR: false,
        issueNumber: entityNumber || "",
        commentBody,
        droidBranch,
        baseBranch,
      };

    case "issues": {
      const issuesPayload = context.payload as IssuesEvent;
      if (!entityNumber) {
        throw new Error("issues event requires issue number");
      }
      if (!baseBranch || !droidBranch) {
        throw new Error("issues event requires baseBranch and droidBranch");
      }

      if (context.eventAction === "opened") {
        return {
          eventName: "issues",
          eventAction: "opened",
          isPR: false,
          issueNumber: entityNumber,
          baseBranch,
          droidBranch,
        };
      }

      if (context.eventAction === "assigned") {
        const assigneePayload = issuesPayload as IssuesAssignedEvent;
        const assignee = assigneePayload.assignee?.login;
        return {
          eventName: "issues",
          eventAction: "assigned",
          isPR: false,
          issueNumber: entityNumber,
          baseBranch,
          droidBranch,
          ...(assignee && { assigneeTrigger: assignee }),
        };
      }

      if (context.eventAction === "labeled") {
        const labeledPayload = issuesPayload as IssuesLabeledEvent;
        const label = labeledPayload.label?.name;
        return {
          eventName: "issues",
          eventAction: "labeled",
          isPR: false,
          issueNumber: entityNumber,
          baseBranch,
          droidBranch,
          labelTrigger: label || "",
        };
      }

      throw new Error(`Unsupported issues action: ${context.eventAction}`);
    }

    case "pull_request":
      if (!context.isPR || !entityNumber) {
        throw new Error("pull_request event requires PR context");
      }
      return {
        eventName: "pull_request",
        eventAction: context.eventAction,
        isPR: true,
        prNumber: entityNumber,
        ...(droidBranch && { droidBranch }),
        ...(baseBranch && { baseBranch }),
      };

    default:
      throw new Error(`Unsupported event type: ${context.eventName}`);
  }
}

export type PromptGenerator = (context: PreparedContext) => string;

export type PromptCreationOptions = {
  githubContext: ParsedGitHubContext;
  commentId: number;
  baseBranch?: string;
  droidBranch?: string;
  prBranchData?: { headRefName: string; headRefOid: string };
  generatePrompt: PromptGenerator;
  allowedTools?: string[];
  disallowedTools?: string[];
  includeActionsTools?: boolean;
};

export async function createPrompt({
  githubContext,
  commentId,
  baseBranch,
  droidBranch,
  prBranchData,
  generatePrompt,
  allowedTools = [],
  disallowedTools = [],
  includeActionsTools = false,
}: PromptCreationOptions) {
  try {
    const droidCommentId = commentId.toString();
    const preparedContext = prepareContext(
      githubContext,
      droidCommentId,
      baseBranch,
      droidBranch,
      prBranchData,
    );

    await mkdir(`${process.env.RUNNER_TEMP || "/tmp"}/droid-prompts`, {
      recursive: true,
    });

    const promptContent = generatePrompt(preparedContext);

    console.log("===== FINAL PROMPT =====");
    console.log(promptContent);
    console.log("=======================");

    await writeFile(
      `${process.env.RUNNER_TEMP || "/tmp"}/droid-prompts/droid-prompt.txt`,
      promptContent,
    );

    const allowedToolsString = buildAllowedToolsString(
      allowedTools,
      includeActionsTools,
    );
    const disallowedToolsString = buildDisallowedToolsString(
      disallowedTools,
      allowedTools,
    );

    core.exportVariable("ALLOWED_TOOLS", allowedToolsString);
    core.exportVariable("DISALLOWED_TOOLS", disallowedToolsString);
  } catch (error) {
    core.setFailed(`Create prompt failed with error: ${error}`);
    process.exit(1);
  }
}
