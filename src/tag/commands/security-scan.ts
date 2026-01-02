import * as core from "@actions/core";
import type { GitHubContext } from "../../github/context";
import { createPrompt } from "../../create-prompt";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import { isEntityContext } from "../../github/context";
import { generateSecurityReportPrompt } from "../../create-prompt/templates/security-report-prompt";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";

export type ScanScope = { type: "full" } | { type: "scheduled"; days: number };

type SecurityScanCommandOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  scanScope: ScanScope;
};

export async function prepareSecurityScanMode({
  context,
  octokit: _octokit,
  githubToken,
  scanScope,
}: SecurityScanCommandOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("Security scan command requires an entity event context");
  }

  const date = new Date().toISOString().split("T")[0];
  const branchName = `droid/security-report-${date}`;

  const branchInfo = {
    baseBranch: "main",
    droidBranch: branchName,
    currentBranch: branchName,
  };

  await createPrompt({
    githubContext: context,
    baseBranch: branchInfo.baseBranch,
    droidBranch: branchInfo.droidBranch,
    generatePrompt: (ctx) =>
      generateSecurityReportPrompt(ctx, scanScope, branchName),
  });
  core.exportVariable("DROID_EXEC_RUN_TYPE", "droid-security-scan");

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
  ];

  const allowedTools = Array.from(
    new Set([...baseTools, ...userAllowedMCPTools]),
  );

  const mcpTools = await prepareMcpTools({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
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
    branchInfo,
    mcpTools,
  };
}
