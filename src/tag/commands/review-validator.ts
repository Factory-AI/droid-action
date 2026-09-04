import * as core from "@actions/core";
import type { GitHubContext } from "../../github/context";
import { isEntityContext } from "../../github/context";
import type { Octokits } from "../../github/api/client";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { createPrompt } from "../../create-prompt";
import type { ReviewArtifacts } from "../../create-prompt/types";
import {
  normalizeDroidArgs,
  stripToolSelectionArgs,
} from "../../utils/parse-tools";
import type { PrepareResult } from "../../prepare/types";
import { generateReviewValidatorPrompt } from "../../create-prompt/templates/review-validator-prompt";
import { resolveReviewConfig } from "../../utils/review-depth";
import { applyModelPolicyFallback } from "../../utils/model-policy";

export async function prepareReviewValidatorMode(options: {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId: number;
}): Promise<PrepareResult> {
  const { context, octokit, trackingCommentId } = options;
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
  const normalizedUserArgs = stripToolSelectionArgs(
    normalizeDroidArgs(rawUserArgs),
  );

  // Pass 2 only writes review_validated.json. It receives no GitHub mutation
  // tools; github-post-review.ts performs the sole API write afterwards.
  const baseTools = [
    "Read",
    "Grep",
    "Glob",
    "LS",
    "Execute",
    "ApplyPatch",
    "Create",
    "Edit",
    "Skill",
  ];

  const allowedTools = Array.from(new Set(baseTools));
  const mcpTools = JSON.stringify({ mcpServers: {} });

  const droidArgParts: string[] = [];
  droidArgParts.push(`--enabled-tools "${allowedTools.join(",")}"`);
  droidArgParts.push('--tag "code-review"');

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
