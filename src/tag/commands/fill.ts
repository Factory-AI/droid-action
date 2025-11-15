import * as core from "@actions/core";
import type { GitHubContext } from "../../github/context";
import { fetchGitHubData } from "../../github/data/fetcher";
import { generateFillPrompt } from "../../create-prompt/templates/fill-prompt";
import { createPrompt } from "../../create-prompt";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import type { GitHubPullRequest } from "../../github/types";
import { isEntityContext } from "../../github/context";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";

type FillCommandOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId?: number;
  triggerTime?: string;
};

export async function prepareFillMode({
  context,
  octokit,
  githubToken,
  trackingCommentId,
  triggerTime,
}: FillCommandOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("Fill command requires an entity event context");
  }

  if (!context.isPR) {
    throw new Error("Fill command is only supported on pull requests");
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
    generatePrompt: generateFillPrompt,
  });
  core.exportVariable("DROID_EXEC_RUN_TYPE", "droid-fill");

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
    "github_pr___update_pr_description",
  ];

  const allowedTools = Array.from(
    new Set([...baseTools, ...userAllowedMCPTools]),
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
