import * as core from "@actions/core";
import { execSync } from "child_process";
import { writeFile, mkdir } from "fs/promises";
import type { GitHubContext } from "../../github/context";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { createPrompt } from "../../create-prompt";
import type { ReviewArtifacts } from "../../create-prompt";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import { isEntityContext } from "../../github/context";
import { generateReviewPrompt } from "../../create-prompt/templates/review-prompt";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";

const DIFF_MAX_BUFFER = 50 * 1024 * 1024; // 50MB buffer for large diffs

async function computeAndStoreDiff(
  baseRef: string,
  tempDir: string,
): Promise<string> {
  const promptsDir = `${tempDir}/droid-prompts`;
  await mkdir(promptsDir, { recursive: true });

  // Unshallow the repo if it's a shallow clone (needed for merge-base to work)
  try {
    execSync("git fetch --unshallow", { encoding: "utf8", stdio: "pipe" });
    console.log("Unshallowed repository");
  } catch (e) {
    // Already unshallowed or not a shallow clone, continue
    console.log("Repository already has full history");
  }

  // Fetch the base branch (it may not exist locally yet)
  try {
    execSync(
      `git fetch origin ${baseRef}:refs/remotes/origin/${baseRef}`,
      { encoding: "utf8", stdio: "pipe" },
    );
    console.log(`Fetched base branch: ${baseRef}`);
  } catch (e) {
    // Branch might already exist, continue
    console.log(`Base branch fetch skipped (may already exist): ${baseRef}`);
  }

  const mergeBase = execSync(
    `git merge-base HEAD refs/remotes/origin/${baseRef}`,
    { encoding: "utf8" },
  ).trim();

  const diff = execSync(`git --no-pager diff ${mergeBase}..HEAD`, {
    encoding: "utf8",
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
    octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    }),
    octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    }),
  ]);

  const comments = {
    issueComments: issueComments.data,
    reviewComments: reviewComments.data,
  };

  const commentsPath = `${promptsDir}/existing_comments.json`;
  await writeFile(commentsPath, JSON.stringify(comments, null, 2));
  console.log(
    `Stored existing comments (${issueComments.data.length} issue, ${reviewComments.data.length} review) at ${commentsPath}`,
  );
  return commentsPath;
}

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

  // Pre-compute review artifacts (diff and existing comments)
  const tempDir = process.env.RUNNER_TEMP || "/tmp";
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

  const reviewArtifacts: ReviewArtifacts = {
    diffPath,
    commentsPath,
  };

  await createPrompt({
    githubContext: context,
    commentId,
    baseBranch: branchInfo.baseBranch,
    droidBranch: branchInfo.droidBranch,
    prBranchData: {
      headRefName: prData.headRefName,
      headRefOid: prData.headRefOid,
    },
    generatePrompt: generateReviewPrompt,
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
  droidArgParts.push(`--enabled-tools "${allowedTools.join(",")}"`);

  const reviewModel = process.env.REVIEW_MODEL?.trim();
  const reasoningEffort = process.env.REASONING_EFFORT?.trim();

  // Default behavior (behind the scenes): if neither is provided, run GPT-5.2 at high reasoning.
  if (!reviewModel && !reasoningEffort) {
    droidArgParts.push(`--model "gpt-5.2"`);
    droidArgParts.push(`--reasoning-effort "high"`);
  } else {
    // Add model override if specified
    if (reviewModel) {
      droidArgParts.push(`--model "${reviewModel}"`);
    }
    // Add reasoning effort override if specified
    if (reasoningEffort) {
      droidArgParts.push(`--reasoning-effort "${reasoningEffort}"`);
    }
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
