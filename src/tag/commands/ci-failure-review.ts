import * as core from "@actions/core";
import { execSync } from "child_process";
import type { WorkflowRunCompletedEvent } from "@octokit/webhooks-types";
import type { GitHubContext } from "../../github/context";
import { isWorkflowRunFailureEvent } from "../../github/context";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { computeReviewArtifacts } from "../../github/data/review-artifacts";
import { createPrompt } from "../../create-prompt";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import {
  generateCIFailureReviewPrompt,
  type CIFailureContext,
} from "../../create-prompt/templates/ci-failure-review-prompt";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";
import type { ParsedGitHubContext } from "../../github/context";

type CIFailureReviewOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
};

export async function prepareCIFailureReviewMode({
  context,
  octokit,
  githubToken,
}: CIFailureReviewOptions): Promise<PrepareResult> {
  if (!isWorkflowRunFailureEvent(context)) {
    throw new Error("CI failure review requires a workflow_run event with failure conclusion");
  }

  const payload = context.payload as WorkflowRunCompletedEvent;
  const workflowRun = payload.workflow_run;
  const prs = workflowRun.pull_requests ?? [];

  if (prs.length === 0) {
    throw new Error(
      "CI failure review requires a workflow_run associated with a pull request",
    );
  }

  const prNumber = prs[0]!.number;

  const ciContext: CIFailureContext = {
    workflowName: workflowRun.name,
    workflowConclusion: workflowRun.conclusion ?? "failure",
    workflowHtmlUrl: workflowRun.html_url,
    workflowRunId: workflowRun.id,
    headSha: workflowRun.head_sha,
    headBranch: workflowRun.head_branch,
  };

  // Build a synthetic entity-like context for createPrompt
  // workflow_run is an automation event but we need PR context for the prompt
  const syntheticContext: ParsedGitHubContext = {
    runId: context.runId,
    eventName: "pull_request",
    eventAction: "workflow_run_failure",
    repository: context.repository,
    actor: context.actor,
    inputs: context.inputs,
    payload: {} as any,
    entityNumber: prNumber,
    isPR: true,
  };

  const prData = await fetchPRBranchData({
    octokits: octokit,
    repository: context.repository,
    prNumber,
  });

  const branchInfo = {
    baseBranch: prData.baseRefName,
    droidBranch: undefined,
    currentBranch: prData.headRefName,
  };

  console.log(
    `Checking out PR #${prNumber} branch for CI failure review...`,
  );
  try {
    execSync("git reset --hard HEAD", { encoding: "utf8", stdio: "pipe" });
    execSync(`gh pr checkout ${prNumber}`, {
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
      `Failed to checkout PR #${prNumber} branch for CI failure review`,
    );
  }

  const tempDir = process.env.RUNNER_TEMP || "/tmp";
  const reviewArtifacts = await computeReviewArtifacts({
    baseRef: prData.baseRefName,
    tempDir,
    octokit,
    owner: context.repository.owner,
    repo: context.repository.repo,
    prNumber,
    title: prData.title,
    body: prData.body,
    githubToken,
  });

  // Post a tracking comment on the PR
  const { data: comment } = await octokit.rest.issues.createComment({
    owner: context.repository.owner,
    repo: context.repository.repo,
    issue_number: prNumber,
    body: `⏳ **Droid CI Failure Review** — analyzing failure in workflow "${ciContext.workflowName}"...`,
  });
  const commentId = comment.id;

  await createPrompt({
    githubContext: syntheticContext,
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
    context: syntheticContext,
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
  core.setOutput("review_pr_number", prNumber.toString());

  return {
    commentId,
    branchInfo,
    mcpTools,
  };
}
