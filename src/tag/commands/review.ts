import * as core from "@actions/core";
import type { GitHubContext } from "../../github/context";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { preparePullRequestHead } from "../../github/data/pr-checkout";
import { computeReviewArtifacts } from "../../github/data/review-artifacts";
import { createPrompt } from "../../create-prompt";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import { isEntityContext } from "../../github/context";
import { generateReviewCandidatesPrompt } from "../../create-prompt/templates/review-candidates-prompt";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";
import { resolveReviewConfig } from "../../utils/review-depth";
import { applyModelPolicyFallback } from "../../utils/model-policy";
import { assertDroidRunType, DroidRunType } from "../../run-type";
import { githubReviewSessionTagArg } from "../../utils/review-session-tag";

type ReviewCommandOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId?: number;
  runType?: DroidRunType | null;
};

export async function prepareReviewMode({
  context,
  octokit,
  githubToken,
  trackingCommentId,
  runType = DroidRunType.Review,
}: ReviewCommandOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("Review command requires an entity event context");
  }

  if (!context.isPR) {
    throw new Error("Review command is only supported on pull requests");
  }
  assertDroidRunType(runType, [
    DroidRunType.Default,
    DroidRunType.Review,
    null,
  ]);

  const commentId =
    trackingCommentId ??
    (await createInitialComment(octokit.rest, context, "default", runType)).id;

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

  const headRevision = await preparePullRequestHead({
    prNumber: context.entityNumber,
    isFork: prData.isFork,
    githubToken,
  });

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
    headRevision,
  });

  const includeSuggestions = process.env.INCLUDE_SUGGESTIONS !== "false";

  await createPrompt({
    githubContext: context,
    commentId,
    baseBranch: branchInfo.baseBranch,
    droidBranch: branchInfo.droidBranch,
    prBranchData: {
      headRefName: prData.headRefName,
      headRefOid: prData.headRefOid,
      isFork: prData.isFork,
      headRevision,
    },
    generatePrompt: generateReviewCandidatesPrompt,
    reviewArtifacts,
    includeSuggestions,
  });
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
  // Skill is needed so review subagents can invoke the review-guidelines skill.
  const candidateGenerationTools = ["Task", "FetchUrl", "Skill"];

  const safeUserAllowedMCPTools = userAllowedMCPTools.filter(
    (tool) =>
      tool === "github_comment___update_droid_comment" ||
      (!tool.startsWith("github_pr___") &&
        tool !== "github_inline_comment___create_inline_comment"),
  );

  const allowedTools = Array.from(
    new Set([
      ...baseTools,
      ...candidateGenerationTools,
      ...safeUserAllowedMCPTools,
    ]),
  );

  const mcpTools = await prepareMcpTools({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    droidCommentId: commentId.toString(),
    runType,
    allowedTools,
    mode: "tag",
    context,
  });

  const droidArgParts: string[] = [];
  droidArgParts.push(`--enabled-tools "${allowedTools.join(",")}"`);
  droidArgParts.push(
    githubReviewSessionTagArg({ pass: "candidates", runType, context }),
  );

  const { model, reasoningEffort, fallbackNote } =
    await applyModelPolicyFallback(
      resolveReviewConfig({
        reviewModel: process.env.REVIEW_MODEL?.trim(),
        reasoningEffort: process.env.REASONING_EFFORT?.trim(),
        reviewDepth: process.env.REVIEW_DEPTH?.trim(),
      }),
      { flowLabel: "code review", modelInputName: "review_model" },
    );

  if (model) {
    droidArgParts.push(`--model "${model}"`);
  }
  if (reasoningEffort) {
    droidArgParts.push(`--reasoning-effort "${reasoningEffort}"`);
  }
  if (fallbackNote) {
    core.setOutput("model_fallback_note", fallbackNote);
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
