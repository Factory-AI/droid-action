import * as core from "@actions/core";
import { execSync } from "child_process";
import type { GitHubContext } from "../../github/context";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { computeReviewArtifacts } from "../../github/data/review-artifacts";
import { createPrompt } from "../../create-prompt";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import { isEntityContext } from "../../github/context";
import { generateReviewPrompt } from "../../create-prompt/templates/review-prompt";
import { generateReviewCandidatesPrompt } from "../../create-prompt/templates/review-candidates-prompt";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";

type ReviewCommandOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId?: number;
};

export async function prepareReviewMode({
  context,
  octokit,
  githubToken,
  trackingCommentId,
}: ReviewCommandOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("Review command requires an entity event context");
  }

  if (!context.isPR) {
    throw new Error("Review command is only supported on pull requests");
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

  // Checkout the PR branch before computing diff
  // This ensures HEAD points to the PR head commit, not the merge commit or default branch
  console.log(
    `Checking out PR #${context.entityNumber} branch for diff computation...`,
  );
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
      `Failed to checkout PR #${context.entityNumber} branch for review`,
    );
  }

  // Pre-compute review artifacts (diff, existing comments, and PR description)
  const tempDir = process.env.RUNNER_TEMP || "/tmp";
  const reviewArtifacts = await computeReviewArtifacts({
    baseRef: prData.baseRefName,
    tempDir,
    octokit,
    owner: context.repository.owner,
    repo: context.repository.repo,
    prNumber: context.entityNumber,
    title: prData.title,
    body: prData.body,
    githubToken,
  });

  const reviewUseValidator =
    (process.env.REVIEW_USE_VALIDATOR ?? "true").trim() !== "false";

  await createPrompt({
    githubContext: context,
    commentId,
    baseBranch: branchInfo.baseBranch,
    droidBranch: branchInfo.droidBranch,
    prBranchData: {
      headRefName: prData.headRefName,
      headRefOid: prData.headRefOid,
    },
    generatePrompt: reviewUseValidator
      ? generateReviewCandidatesPrompt
      : generateReviewPrompt,
    reviewArtifacts,
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
    "Edit",
    "Create",
    "ApplyPatch",
    "github_comment___update_droid_comment",
  ];

  // Task tool is needed for parallel subagent reviews in candidate generation phase.
  // FetchUrl is needed to fetch linked tickets from the PR description.
  const candidateGenerationTools = reviewUseValidator
    ? ["Task", "FetchUrl"]
    : [];

  const reviewTools = reviewUseValidator
    ? []
    : [
        "github_inline_comment___create_inline_comment",
        "github_pr___list_review_comments",
        "github_pr___submit_review",
        "github_pr___delete_comment",
        "github_pr___minimize_comment",
        "github_pr___reply_to_comment",
        "github_pr___resolve_review_thread",
      ];

  const safeUserAllowedMCPTools = reviewUseValidator
    ? userAllowedMCPTools.filter(
        (tool) =>
          tool === "github_comment___update_droid_comment" ||
          (!tool.startsWith("github_pr___") &&
            tool !== "github_inline_comment___create_inline_comment"),
      )
    : userAllowedMCPTools;

  const allowedTools = Array.from(
    new Set([
      ...baseTools,
      ...candidateGenerationTools,
      ...reviewTools,
      ...safeUserAllowedMCPTools,
    ]),
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
  droidArgParts.push('--tag "code-review"');

  const reviewModel = process.env.REVIEW_MODEL?.trim();
  const reasoningEffort = process.env.REASONING_EFFORT?.trim();

  if (reviewModel) {
    droidArgParts.push(`--model "${reviewModel}"`);
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
  core.setOutput("droid_comment_id", commentId.toString());

  return {
    commentId,
    branchInfo,
    mcpTools,
  };
}
