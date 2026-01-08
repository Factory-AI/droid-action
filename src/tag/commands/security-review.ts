import * as core from "@actions/core";
import type { GitHubContext } from "../../github/context";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { createPrompt } from "../../create-prompt";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import { isEntityContext } from "../../github/context";
import { generateSecurityReviewPrompt } from "../../create-prompt/templates/security-review-prompt";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";

type SecurityReviewCommandOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId?: number;
};

export async function prepareSecurityReviewMode({
  context,
  octokit,
  githubToken,
  trackingCommentId,
}: SecurityReviewCommandOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("Security review command requires an entity event context");
  }

  if (!context.isPR) {
    throw new Error(
      "Security review command is only supported on pull requests",
    );
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

  await createPrompt({
    githubContext: context,
    commentId,
    baseBranch: branchInfo.baseBranch,
    droidBranch: branchInfo.droidBranch,
    prBranchData: {
      headRefName: prData.headRefName,
      headRefOid: prData.headRefOid,
    },
    generatePrompt: generateSecurityReviewPrompt,
  });
  core.exportVariable("DROID_EXEC_RUN_TYPE", "droid-security-review");

  // Signal that security skills should be installed
  core.setOutput("install_security_skills", "true");

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

  // Add model override if specified (prefer SECURITY_MODEL, fallback to REVIEW_MODEL)
  const securityModel =
    process.env.SECURITY_MODEL?.trim() || process.env.REVIEW_MODEL?.trim();
  if (securityModel) {
    droidArgParts.push(`--model "${securityModel}"`);
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
