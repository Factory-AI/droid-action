#!/usr/bin/env bun

/**
 * Generate review prompt for standalone review/security actions
 */

import * as core from "@actions/core";
import { execSync } from "child_process";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { fetchPRBranchData } from "../github/data/pr-fetcher";
import { computeReviewArtifacts } from "../github/data/review-artifacts";
import { createPrompt } from "../create-prompt";
import { prepareMcpTools } from "../mcp/install-mcp-server";
import { generateReviewPrompt } from "../create-prompt/templates/review-prompt";
import { generateReviewCandidatesPrompt } from "../create-prompt/templates/review-candidates-prompt";
import { generateSecurityReviewPrompt } from "../create-prompt/templates/security-review-prompt";
import { normalizeDroidArgs, parseAllowedTools } from "../utils/parse-tools";

async function run() {
  try {
    const githubToken = process.env.GITHUB_TOKEN!;
    const reviewType = process.env.REVIEW_TYPE || "code";
    const reviewUseValidator =
      reviewType === "code" &&
      (process.env.REVIEW_USE_VALIDATOR ?? "true").trim() !== "false";
    const commentId = parseInt(process.env.DROID_COMMENT_ID || "0");

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

    const prData = await fetchPRBranchData({
      octokits: octokit,
      repository: context.repository,
      prNumber: context.entityNumber,
    });

    const branchInfo = {
      baseBranch: prData.baseRefName,
      currentBranch: prData.headRefName,
    };

    // Pre-compute review artifacts (diff, existing comments, PR description)
    // so the Droid can read them directly instead of fetching via gh CLI
    const tempDir = process.env.RUNNER_TEMP || "/tmp";

    // Checkout the PR branch before computing diff to ensure HEAD points
    // to the PR head commit, not the merge commit
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

    // Select prompt generator based on review type and validator mode
    const generatePrompt =
      reviewType === "security"
        ? generateSecurityReviewPrompt
        : reviewUseValidator
          ? generateReviewCandidatesPrompt
          : generateReviewPrompt;

    // Pass the output file path so the prompt can instruct the Droid
    // to write structured findings for the combine step
    const outputFilePath = process.env.DROID_OUTPUT_FILE || undefined;

    await createPrompt({
      githubContext: context,
      commentId,
      baseBranch: branchInfo.baseBranch,
      prBranchData: {
        headRefName: prData.headRefName,
        headRefOid: prData.headRefOid,
      },
      generatePrompt,
      reviewArtifacts,
      outputFilePath,
    });

    // Set run type
    const runType =
      reviewType === "security" ? "droid-security-review" : "droid-review";
    core.exportVariable("DROID_EXEC_RUN_TYPE", runType);

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
    const candidateGenerationTools = reviewUseValidator
      ? ["Task", "FetchUrl"]
      : [];

    // When validator is enabled, the candidate generation phase should NOT
    // have access to PR mutation tools. When disabled, allow them.
    const reviewTools = reviewUseValidator
      ? []
      : ["github_pr___list_review_comments"];

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
    // Only include built-in tools in --enabled-tools
    // MCP tools are discovered dynamically from registered servers
    const builtInTools = allowedTools.filter((t) => !t.includes("___"));
    if (builtInTools.length > 0) {
      droidArgParts.push(`--enabled-tools "${builtInTools.join(",")}"`);
    }

    const reviewModel =
      reviewType === "security"
        ? process.env.SECURITY_MODEL?.trim() || process.env.REVIEW_MODEL?.trim()
        : process.env.REVIEW_MODEL?.trim();
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

    // Output for next step - use core.setOutput which handles GITHUB_OUTPUT internally
    core.setOutput("droid_args", droidArgParts.join(" ").trim());
    core.setOutput("mcp_tools", mcpTools);
    core.setOutput("review_use_validator", reviewUseValidator.toString());

    console.log(
      `Generated ${reviewType} review prompt (validator=${reviewUseValidator})`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Generate prompt failed: ${errorMessage}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
