#!/usr/bin/env bun

/**
 * Generate review prompt for standalone review/security actions
 */

import * as core from "@actions/core";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { fetchPRBranchData } from "../github/data/pr-fetcher";
import { createPrompt } from "../create-prompt";
import { prepareMcpTools } from "../mcp/install-mcp-server";
import { generateReviewPrompt } from "../create-prompt/templates/review-prompt";
import { generateSecurityReviewPrompt } from "../create-prompt/templates/security-review-prompt";
import { normalizeDroidArgs, parseAllowedTools } from "../utils/parse-tools";

async function run() {
  try {
    const githubToken = process.env.GITHUB_TOKEN!;
    const reviewType = process.env.REVIEW_TYPE || "code";
    const commentId = parseInt(process.env.DROID_COMMENT_ID || "0");

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

    // Select prompt generator based on review type
    const generatePrompt = reviewType === "security" 
      ? generateSecurityReviewPrompt 
      : generateReviewPrompt;

    await createPrompt({
      githubContext: context,
      commentId,
      baseBranch: branchInfo.baseBranch,
      prBranchData: {
        headRefName: prData.headRefName,
        headRefOid: prData.headRefOid,
      },
      generatePrompt,
    });

    // Set run type
    const runType = reviewType === "security" ? "droid-security-review" : "droid-review";
    core.exportVariable("DROID_EXEC_RUN_TYPE", runType);

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
    // Only include built-in tools in --enabled-tools
    // MCP tools are discovered dynamically from registered servers
    const builtInTools = allowedTools.filter(t => !t.includes("___"));
    if (builtInTools.length > 0) {
      droidArgParts.push(`--enabled-tools "${builtInTools.join(",")}"`);
    }

    // Add model override if specified
    const model = reviewType === "security" 
      ? (process.env.SECURITY_MODEL?.trim() || process.env.REVIEW_MODEL?.trim())
      : process.env.REVIEW_MODEL?.trim();
    
    if (model) {
      droidArgParts.push(`--model "${model}"`);
    }

    if (normalizedUserArgs) {
      droidArgParts.push(normalizedUserArgs);
    }

    // Output for next step - use core.setOutput which handles GITHUB_OUTPUT internally
    core.setOutput("droid_args", droidArgParts.join(" ").trim());
    core.setOutput("mcp_tools", mcpTools);

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
