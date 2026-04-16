import * as core from "@actions/core";
import type { GitHubContext } from "../../github/context";
import { isEntityContext } from "../../github/context";
import type { Octokits } from "../../github/api/client";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { createPrompt } from "../../create-prompt";
import type { ReviewArtifacts } from "../../create-prompt/types";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import type { PrepareResult } from "../../prepare/types";
import { generateReviewValidatorPrompt } from "../../create-prompt/templates/review-validator-prompt";
import { resolveReviewConfig } from "../../utils/review-depth";

export async function prepareReviewValidatorMode({
  context,
  octokit,
  githubToken,
  trackingCommentId,
}: {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId: number;
}): Promise<PrepareResult> {
  if (!isEntityContext(context) || !context.isPR) {
    throw new Error("review validator mode requires pull request context");
  }

  const prData = await fetchPRBranchData({
    octokits: octokit,
    repository: {
      owner: context.repository.owner,
      repo: context.repository.repo,
    },
    prNumber: context.entityNumber,
  });

  // The PR branch is already checked out and review artifacts (diff,
  // comments, description) were already computed by the generate-review-prompt
  // step earlier in this job. Reuse them from disk instead of recomputing.
  const tempDir = process.env.RUNNER_TEMP || "/tmp";
  const promptsDir = `${tempDir}/droid-prompts`;
  const reviewArtifacts: ReviewArtifacts = {
    diffPath: `${promptsDir}/pr.diff`,
    commentsPath: `${promptsDir}/existing_comments.json`,
    descriptionPath: `${promptsDir}/pr_description.txt`,
  };

  const includeSuggestions = process.env.INCLUDE_SUGGESTIONS !== "false";

  await createPrompt({
    githubContext: context,
    commentId: trackingCommentId,
    baseBranch: prData.baseRefName,
    droidBranch: prData.headRefName,
    prBranchData: {
      headRefName: prData.headRefName,
      headRefOid: prData.headRefOid,
    },
    generatePrompt: generateReviewValidatorPrompt,
    reviewArtifacts,
    includeSuggestions,
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
    "ApplyPatch",
    "Create",
    "Edit",
    "github_comment___update_droid_comment",
  ];

  const validatorTools = ["github_pr___submit_review"];

  const allowedTools = Array.from(
    new Set([...baseTools, ...validatorTools, ...userAllowedMCPTools]),
  );

  const mcpTools = await prepareMcpTools({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    droidCommentId: trackingCommentId.toString(),
    allowedTools,
    mode: "tag",
    context,
  });

  const droidArgParts: string[] = [];
  droidArgParts.push(`--enabled-tools "${allowedTools.join(",")}"`);
  droidArgParts.push('--tag "code-review"');

  const { model, reasoningEffort } = resolveReviewConfig({
    reviewModel: process.env.REVIEW_MODEL?.trim(),
    reasoningEffort: process.env.REASONING_EFFORT?.trim(),
    reviewDepth: process.env.REVIEW_DEPTH?.trim(),
  });

  if (model) {
    droidArgParts.push(`--model "${model}"`);
  }
  if (reasoningEffort) {
    droidArgParts.push(`--reasoning-effort "${reasoningEffort}"`);
  }

  if (normalizedUserArgs) {
    droidArgParts.push(normalizedUserArgs);
  }

  core.setOutput("droid_args", droidArgParts.join(" ").trim());
  core.setOutput("mcp_tools", mcpTools);
  core.setOutput("review_pr_number", context.entityNumber.toString());
  core.setOutput("droid_comment_id", trackingCommentId.toString());

  return {
    commentId: trackingCommentId,
    branchInfo: {
      baseBranch: prData.baseRefName,
      droidBranch: prData.headRefName,
      currentBranch: prData.headRefName,
    },
    mcpTools,
  };
}
