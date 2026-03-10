import * as core from "@actions/core";
import { execSync } from "child_process";
import type { CheckRunEvent } from "@octokit/webhooks-types";
import type { GitHubContext } from "../../github/context";
import { isCheckRunEvent, isEntityContext } from "../../github/context";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { computeReviewArtifacts } from "../../github/data/review-artifacts";
import { createPrompt } from "../../create-prompt";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import {
  generateCIFailureReviewPrompt,
  type CIFailureContext,
} from "../../create-prompt/templates/ci-failure-review-prompt";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";

type CIFailureReviewOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId?: number;
};

export async function prepareCIFailureReviewMode({
  context,
  octokit,
  githubToken,
  trackingCommentId,
}: CIFailureReviewOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("CI failure review requires an entity event context");
  }

  if (!isCheckRunEvent(context)) {
    throw new Error("CI failure review requires a check_run event");
  }

  if (!context.isPR) {
    throw new Error(
      "CI failure review requires a check_run associated with a pull request",
    );
  }

  const checkRunPayload = context.payload as CheckRunEvent;
  const checkRun = checkRunPayload.check_run;

  const ciContext: CIFailureContext = {
    checkRunName: checkRun.name,
    checkRunConclusion: checkRun.conclusion ?? "failure",
    checkRunHtmlUrl: checkRun.html_url,
    checkRunId: checkRun.id,
    headSha: checkRun.head_sha,
  };

  const commentId =
    trackingCommentId ??
    (await createInitialComment(octokit.rest, context, "default")).id;

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

  console.log(
    `Checking out PR #${context.entityNumber} branch for CI failure review...`,
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
      `Failed to checkout PR #${context.entityNumber} branch for CI failure review`,
    );
  }

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

  await createPrompt({
    githubContext: context,
    commentId,
    baseBranch: branchInfo.baseBranch,
    droidBranch: branchInfo.droidBranch,
    prBranchData: {
      headRefName: prData.headRefName,
      headRefOid: prData.headRefOid,
    },
    generatePrompt: (preparedContext) =>
      generateCIFailureReviewPrompt(preparedContext, ciContext),
    includeActionsTools: true,
    reviewArtifacts,
  });

  core.exportVariable("DROID_EXEC_RUN_TYPE", "droid-ci-failure-review");

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
    "github_inline_comment___create_inline_comment",
    "github_pr___submit_review",
  ];

  const ciTools = [
    "github_ci___get_ci_status",
    "github_ci___get_workflow_run_details",
    "github_ci___download_job_log",
  ];

  const allowedTools = Array.from(
    new Set([...baseTools, ...ciTools, ...userAllowedMCPTools]),
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
  droidArgParts.push('--tag "ci-failure-review"');

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
  core.setOutput("droid_comment_id", commentId.toString());

  return {
    commentId,
    branchInfo,
    mcpTools,
  };
}
