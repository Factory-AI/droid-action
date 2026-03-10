import * as core from "@actions/core";
import { execSync } from "child_process";
import type { GitHubContext } from "../../github/context";
import {
  isEntityContext,
  isPullRequestReviewCommentEvent,
} from "../../github/context";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { createPrompt } from "../../create-prompt";
import type { FixContext } from "../../create-prompt/types";
import { generateFixPrompt } from "../../create-prompt/templates/fix-prompt";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";

type FixCommandOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId?: number;
};

export async function prepareFixMode({
  context,
  octokit,
  githubToken,
  trackingCommentId,
}: FixCommandOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("Fix command requires an entity event context");
  }

  if (!context.isPR) {
    throw new Error("Fix command is only supported on pull requests");
  }

  const commentId =
    trackingCommentId ?? (await createInitialComment(octokit.rest, context)).id;

  const prData = await fetchPRBranchData({
    octokits: octokit,
    repository: context.repository,
    prNumber: context.entityNumber,
  });

  const branchInfo = {
    baseBranch: prData.baseRefName,
    droidBranch: undefined,
    currentBranch: prData.headRefName,
  };

  // Checkout the PR branch so Droid can commit and push fixes
  console.log(`Checking out PR #${context.entityNumber} branch for fix...`);
  try {
    execSync("git reset --hard HEAD", { encoding: "utf8", stdio: "pipe" });
    execSync(`gh pr checkout ${context.entityNumber}`, {
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, GH_TOKEN: githubToken },
    });
    console.log(
      `Successfully checked out PR branch: ${execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim()}`,
    );
  } catch (e) {
    console.error(`Failed to checkout PR branch: ${e}`);
    throw new Error(
      `Failed to checkout PR #${context.entityNumber} branch for fix`,
    );
  }

  // Build fix context for review thread replies
  const fixContext = await buildFixContext(context, octokit);

  await createPrompt({
    githubContext: context,
    commentId,
    baseBranch: branchInfo.baseBranch,
    droidBranch: branchInfo.droidBranch,
    prBranchData: {
      headRefName: prData.headRefName,
      headRefOid: prData.headRefOid,
    },
    generatePrompt: generateFixPrompt,
    fixContext,
  });
  core.exportVariable("DROID_EXEC_RUN_TYPE", "droid-fix");

  const rawUserArgs = process.env.DROID_ARGS || "";
  const normalizedUserArgs = normalizeDroidArgs(rawUserArgs);
  const userAllowedMCPTools = parseAllowedTools(normalizedUserArgs).filter(
    (tool) => tool.startsWith("github_") && tool.includes("___"),
  );

  const baseTools = [
    "Read",
    "Grep",
    "Glob",
    "LS",
    "Execute",
    "Edit",
    "Create",
    "ApplyPatch",
    "FetchUrl",
    "github_comment___update_droid_comment",
  ];

  const safeUserAllowedMCPTools = userAllowedMCPTools.filter(
    (tool) =>
      tool === "github_comment___update_droid_comment" ||
      !tool.startsWith("github_pr___"),
  );

  const allowedTools = Array.from(
    new Set([...baseTools, ...safeUserAllowedMCPTools]),
  );

  const mcpTools = await prepareMcpTools({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    droidCommentId: commentId.toString(),
    allowedTools,
    mode: "tag",
    context,
  });

  const droidArgParts: string[] = [];
  droidArgParts.push(`--enabled-tools "${allowedTools.join(",")}"`);
  droidArgParts.push('--tag "droid-fix"');

  const fixModel = process.env.FIX_MODEL?.trim();
  if (fixModel) {
    droidArgParts.push(`--model "${fixModel}"`);
  }

  if (normalizedUserArgs) {
    droidArgParts.push(normalizedUserArgs);
  }

  core.setOutput("droid_args", droidArgParts.join(" ").trim());
  core.setOutput("mcp_tools", mcpTools);

  return {
    commentId,
    branchInfo,
    mcpTools,
  };
}

async function buildFixContext(
  context: GitHubContext,
  octokit: Octokits,
): Promise<FixContext | undefined> {
  if (!isPullRequestReviewCommentEvent(context)) {
    return undefined;
  }

  const comment = context.payload.comment;
  const filePath = comment.path || "unknown";
  const line = comment.line ?? comment.original_line ?? null;

  // If this comment is a reply in a thread, fetch the parent comment
  // to get the original review finding
  const inReplyToId = (comment as { in_reply_to_id?: number }).in_reply_to_id;
  let parentCommentBody = comment.body || "";

  if (inReplyToId) {
    try {
      const parentComment = await octokit.rest.pulls.getReviewComment({
        owner: context.repository.owner,
        repo: context.repository.repo,
        comment_id: inReplyToId,
      });
      parentCommentBody = parentComment.data.body || comment.body || "";
    } catch (e) {
      console.warn(
        `Failed to fetch parent review comment ${inReplyToId}: ${e}`,
      );
    }
  }

  return {
    parentCommentBody,
    filePath,
    line,
  };
}
