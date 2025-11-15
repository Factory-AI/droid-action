import * as core from "@actions/core";
import type { GitHubContext } from "../../github/context";
import { fetchGitHubData } from "../../github/data/fetcher";
import { createPrompt } from "../../create-prompt";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import type { GitHubPullRequest } from "../../github/types";
import { isEntityContext } from "../../github/context";
import { generateReviewPrompt } from "../../create-prompt/templates/review-prompt";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";

type ReviewCommandOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId?: number;
  triggerTime?: string;
};

export async function prepareReviewMode({
  context,
  octokit,
  githubToken,
  trackingCommentId,
  triggerTime,
}: ReviewCommandOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("Review command requires an entity event context");
  }

  if (!context.isPR) {
    throw new Error("Review command is only supported on pull requests");
  }

  const commentId =
    trackingCommentId ?? (await createInitialComment(octokit.rest, context)).id;

  const githubData = await fetchGitHubData({
    octokits: octokit,
    repository: `${context.repository.owner}/${context.repository.repo}`,
    prNumber: context.entityNumber.toString(),
    isPR: true,
    triggerUsername: context.actor,
    triggerTime,
  });

  const prData = githubData.contextData as GitHubPullRequest;
  const branchInfo = {
    baseBranch: prData.baseRefName,
    droidBranch: undefined,
    currentBranch: prData.headRefName,
  };

  await createPrompt({
    githubContext: context,
    githubData,
    commentId,
    baseBranch: branchInfo.baseBranch,
    droidBranch: branchInfo.droidBranch,
    generatePrompt: generateReviewPrompt,
  });
  core.exportVariable("DROID_EXEC_RUN_TYPE", "droid-review");

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
    "github_comment___update_droid_comment",
    "github_inline_comment___create_inline_comment",
  ];

  const reviewTools = [
    "github_pr___list_review_comments",
    "github_pr___submit_review",
    "github_pr___delete_comment",
    "github_pr___minimize_comment",
    "github_pr___reply_to_comment",
    "github_pr___resolve_review_thread",
  ];

  const allowedTools = Array.from(
    new Set([...baseTools, ...reviewTools, ...userAllowedMCPTools]),
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
