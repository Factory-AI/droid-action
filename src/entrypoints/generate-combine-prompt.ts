#!/usr/bin/env bun

/**
 * Generate combine prompt for finalizing parallel reviews
 */

import * as core from "@actions/core";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { fetchPRBranchData } from "../github/data/pr-fetcher";
import { createPrompt } from "../create-prompt";
import { prepareMcpTools } from "../mcp/install-mcp-server";
import { generateCombinePrompt } from "../create-prompt/templates/combine-prompt";
import { normalizeDroidArgs, parseAllowedTools } from "../utils/parse-tools";

async function run() {
  try {
    const githubToken = process.env.GITHUB_TOKEN!;
    const commentId = parseInt(process.env.DROID_COMMENT_ID || "0");
    const codeReviewResults = process.env.CODE_REVIEW_RESULTS || "";
    const securityResults = process.env.SECURITY_RESULTS || "";

    const context = parseGitHubContext();

    if (!isEntityContext(context)) {
      throw new Error("Combine requires entity context (PR or issue)");
    }

    if (!context.isPR) {
      throw new Error("Combine is only supported on pull requests");
    }

    const octokit = createOctokit(githubToken);

    const prData = await fetchPRBranchData({
      octokits: octokit,
      repository: context.repository,
      prNumber: context.entityNumber,
    });

    // Generate combine prompt with paths to result files
    await createPrompt({
      githubContext: context,
      commentId,
      baseBranch: prData.baseRefName,
      prBranchData: {
        headRefName: prData.headRefName,
        headRefOid: prData.headRefOid,
      },
      generatePrompt: (ctx) =>
        generateCombinePrompt(ctx, codeReviewResults, securityResults),
    });

    core.exportVariable("DROID_EXEC_RUN_TYPE", "droid-combine");

    const rawUserArgs = process.env.DROID_ARGS || "";
    const normalizedUserArgs = normalizeDroidArgs(rawUserArgs);
    const userAllowedMCPTools = parseAllowedTools(normalizedUserArgs).filter(
      (tool) => tool.startsWith("github_") && tool.includes("___"),
    );

    // Combine step has tools for inline comments and tracking comment update
    // NO github_pr___submit_review - it creates duplicate summary comments
    const baseTools = [
      "Read",
      "Grep",
      "Glob",
      "LS",
      "Execute",
      "github_comment___update_droid_comment",
      "github_inline_comment___create_inline_comment",
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
    // Only include built-in tools in --enabled-tools
    const builtInTools = allowedTools.filter((t) => !t.includes("___"));
    if (builtInTools.length > 0) {
      droidArgParts.push(`--enabled-tools "${builtInTools.join(",")}"`);
    }

    if (normalizedUserArgs) {
      droidArgParts.push(normalizedUserArgs);
    }

    core.setOutput("droid_args", droidArgParts.join(" ").trim());
    core.setOutput("mcp_tools", mcpTools);

    console.log(`Generated combine prompt`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Generate combine prompt failed: ${errorMessage}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
