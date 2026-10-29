#!/usr/bin/env bun

/**
 * Generate review prompt for standalone review/security actions
 */

import * as core from "@actions/core";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { fetchPRBranchData } from "../github/data/pr-fetcher";
import { preparePullRequestHead } from "../github/data/pr-checkout";
import { computeReviewArtifacts } from "../github/data/review-artifacts";
import { createPrompt } from "../create-prompt";
import { prepareMcpTools } from "../mcp/install-mcp-server";
import { generateReviewCandidatesPrompt } from "../create-prompt/templates/review-candidates-prompt";
import { generateSecurityCandidatesPrompt } from "../create-prompt/templates/security-review-prompt";
import { normalizeDroidArgs, parseAllowedTools } from "../utils/parse-tools";
import { resolveReviewConfig } from "../utils/review-depth";
import { applyModelPolicyFallback } from "../utils/model-policy";
import { DroidRunType, setDroidRunType } from "../run-type";
import { githubReviewSessionTagArg } from "../utils/review-session-tag";
import { initializeReviewConfig } from "../prepare/review-config";
import { freezeReviewRuntime } from "../prepare/review-runtime";
import { automaticReviewSkipReason } from "../core/review/config";
import {
  prepareReviewLifecycle,
  readReviewLifecycle,
} from "../github/operations/review-lifecycle";

async function run() {
  try {
    const githubToken = process.env.GITHUB_TOKEN!;
    const reviewType = process.env.REVIEW_TYPE || "code";
    const runType =
      reviewType === "security"
        ? DroidRunType.SecurityReview
        : DroidRunType.Review;
    setDroidRunType(runType);
    let commentId = parseInt(process.env.DROID_COMMENT_ID || "0");

    if (!commentId) {
      throw new Error("DROID_COMMENT_ID is required and must be non-zero");
    }

    const context = parseGitHubContext();

    if (!isEntityContext(context)) {
      throw new Error("Review requires entity context (PR or issue)");
    }

    if (!context.isPR) {
      throw new Error("Review is only supported on pull requests");
    }

    const octokit = createOctokit(githubToken);
    await initializeReviewConfig(context, octokit);
    await freezeReviewRuntime();

    const prData = await fetchPRBranchData({
      octokits: octokit,
      repository: context.repository,
      prNumber: context.entityNumber,
    });
    core.setOutput("review_head_sha", prData.headRefOid);
    const config = context.inputs.reviewConfig!;
    const skipReason = automaticReviewSkipReason({
      config,
      draft:
        "pull_request" in context.payload &&
        !!context.payload.pull_request.draft,
      eventAction: context.eventAction,
      manual: context.eventName !== "pull_request",
    });
    const lifecycle = await prepareReviewLifecycle({
      octokit,
      context,
      headSha: prData.headRefOid,
      baseSha: process.env.REVIEW_BASE_SHA,
      trackingCommentId: commentId,
      securityOnly: reviewType === "security",
      skipReason: skipReason ?? undefined,
    });
    commentId = lifecycle.commentId;
    core.setOutput("droid_comment_id", String(commentId));
    if (lifecycle.skipReason) {
      core.setOutput("review_skipped", "true");
      return;
    }

    const branchInfo = {
      baseBranch: prData.baseRefName,
      currentBranch: prData.headRefName,
    };

    // Pre-compute review artifacts (diff, existing comments, PR description)
    // so the Droid can read them directly instead of fetching via gh CLI
    const tempDir = process.env.RUNNER_TEMP || "/tmp";

    const headRevision = await preparePullRequestHead({
      prNumber: context.entityNumber,
      isFork: prData.isFork,
      githubToken,
    });

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
      incrementalBaseSha: lifecycle.incrementalBaseSha,
    });
    if ((await readReviewLifecycle())?.skipReason) {
      core.setOutput("review_skipped", "true");
      return;
    }

    // Select prompt generator based on review type
    const generatePrompt =
      reviewType === "security"
        ? generateSecurityCandidatesPrompt
        : generateReviewCandidatesPrompt;

    // Pass the output file path so the prompt can instruct the Droid
    // to write structured findings for the combine step
    const outputFilePath = process.env.DROID_OUTPUT_FILE || undefined;
    const includeSuggestions = process.env.INCLUDE_SUGGESTIONS !== "false";

    await createPrompt({
      githubContext: context,
      commentId,
      baseBranch: branchInfo.baseBranch,
      prBranchData: {
        headRefName: prData.headRefName,
        headRefOid: prData.headRefOid,
        isFork: prData.isFork,
        headRevision,
      },
      generatePrompt,
      reviewArtifacts,
      outputFilePath,
      includeSuggestions,
    });

    const rawUserArgs = process.env.DROID_ARGS || "";
    const normalizedUserArgs = normalizeDroidArgs(rawUserArgs);
    const userAllowedMCPTools = parseAllowedTools(normalizedUserArgs).filter(
      (tool) => tool.startsWith("github_") && tool.includes("___"),
    );

    // Base tools for analysis
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
    // Skill is needed so subagents can invoke review/security-review skills.
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

    const rawModel =
      reviewType === "security"
        ? process.env.SECURITY_MODEL?.trim() || process.env.REVIEW_MODEL?.trim()
        : process.env.REVIEW_MODEL?.trim();

    const { model, reasoningEffort, fallbackNote } =
      await applyModelPolicyFallback(
        resolveReviewConfig({
          reviewModel: rawModel,
          reasoningEffort: process.env.REASONING_EFFORT?.trim(),
          reviewDepth: process.env.REVIEW_DEPTH?.trim(),
        }),
        {
          flowLabel:
            reviewType === "security" ? "security review" : "code review",
          modelInputName:
            reviewType === "security" ? "security_model" : "review_model",
        },
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
    core.setOutput("review_model", model);
    core.setOutput("review_reasoning_effort", reasoningEffort || "");

    if (normalizedUserArgs) {
      droidArgParts.push(normalizedUserArgs);
    }

    // Output for next step - use core.setOutput which handles GITHUB_OUTPUT internally
    core.setOutput("droid_args", droidArgParts.join(" ").trim());
    core.setOutput("mcp_tools", mcpTools);
    // Both code and security reviews use the two-pass pipeline (candidates + validator)
    core.setOutput("review_use_validator", "true");

    console.log(`Generated ${reviewType} review prompt`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Generate prompt failed: ${errorMessage}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
