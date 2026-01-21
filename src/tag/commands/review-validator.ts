import * as core from "@actions/core";
import type { GitHubContext } from "../../github/context";
import { isEntityContext } from "../../github/context";
import type { Octokits } from "../../github/api/client";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { createPrompt } from "../../create-prompt";
import type { ReviewArtifacts } from "../../create-prompt";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import type { PrepareResult } from "../../prepare/types";
import { generateReviewValidatorPrompt } from "../../create-prompt/templates/review-validator-prompt";
import { execSync } from "child_process";
import { mkdir, writeFile } from "fs/promises";

const DIFF_MAX_BUFFER = 50 * 1024 * 1024;

async function computeAndStoreDiff(
  baseRef: string,
  tempDir: string,
): Promise<string> {
  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });

  try {
    execSync("git fetch --unshallow", { encoding: "utf8", stdio: "pipe" });
    console.log("Unshallowed repository");
  } catch {
    console.log("Repository already has full history");
  }

  try {
    execSync(`git fetch origin ${baseRef}:refs/remotes/origin/${baseRef}`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    console.log(`Fetched base branch: ${baseRef}`);
  } catch (e) {
    console.error(`Failed to fetch base branch ${baseRef}: ${e}`);
    throw new Error(`Failed to fetch base branch ${baseRef} for review`);
  }

  const mergeBase = execSync(`git merge-base HEAD origin/${baseRef}`, {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();

  const diff = execSync(`git --no-pager diff ${mergeBase}..HEAD`, {
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: DIFF_MAX_BUFFER,
  });

  const diffPath = `${promptsDir}/pr.diff`;
  await writeFile(diffPath, diff);
  console.log(`Stored PR diff (${diff.length} bytes) at ${diffPath}`);

  return diffPath;
}

async function fetchAndStoreComments(
  octokit: Octokits,
  owner: string,
  repo: string,
  prNumber: number,
  tempDir: string,
): Promise<string> {
  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });

  const [issueComments, reviewComments] = await Promise.all([
    octokit.rest.issues.listComments({ owner, repo, issue_number: prNumber }),
    octokit.rest.pulls.listReviewComments({ owner, repo, pull_number: prNumber }),
  ]);

  const commentsPath = `${promptsDir}/existing_comments.json`;
  const payload = {
    issueComments: issueComments.data,
    reviewComments: reviewComments.data,
  };
  await writeFile(commentsPath, JSON.stringify(payload, null, 2));
  console.log(
    `Stored existing comments (${issueComments.data.length} issue, ${reviewComments.data.length} review) at ${commentsPath}`,
  );

  return commentsPath;
}

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
    repository: { owner: context.repository.owner, repo: context.repository.repo },
    prNumber: context.entityNumber,
  });

  const tempDir = process.env.RUNNER_TEMP || "/tmp";

  // Ensure PR branch is checked out (same as review mode)
  try {
    execSync("git reset --hard HEAD", { encoding: "utf8", stdio: "pipe" } as any);
    execSync(`gh pr checkout ${context.entityNumber}`, {
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, GH_TOKEN: githubToken },
    });
    console.log(
      `Successfully checked out PR branch: ${execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" } as any).trim()}`,
    );
  } catch (e) {
    console.error(`Failed to checkout PR branch: ${e}`);
    throw new Error(`Failed to checkout PR #${context.entityNumber} branch for review`);
  }

  const [diffPath, commentsPath] = await Promise.all([
    computeAndStoreDiff(prData.baseRefName, tempDir),
    fetchAndStoreComments(
      octokit,
      context.repository.owner,
      context.repository.repo,
      context.entityNumber,
      tempDir,
    ),
  ]);

  const reviewArtifacts: ReviewArtifacts = { diffPath, commentsPath };

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
    "github_inline_comment___create_inline_comment",
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

  const reviewModel = process.env.REVIEW_MODEL?.trim();
  const reasoningEffort = process.env.REASONING_EFFORT?.trim();

  if (!reviewModel && !reasoningEffort) {
    droidArgParts.push(`--model "gpt-5.2"`);
    droidArgParts.push(`--reasoning-effort "high"`);
  } else {
    if (reviewModel) droidArgParts.push(`--model "${reviewModel}"`);
    if (reasoningEffort) droidArgParts.push(`--reasoning-effort "${reasoningEffort}"`);
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
