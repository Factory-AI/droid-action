import * as core from "@actions/core";
import type { GitHubContext } from "../../github/context";
import { fetchPRBranchData } from "../../github/data/pr-fetcher";
import { preparePullRequestHead } from "../../github/data/pr-checkout";
import { computeReviewArtifacts } from "../../github/data/review-artifacts";
import { createPrompt } from "../../create-prompt";
import { prepareMcpTools } from "../../mcp/install-mcp-server";
import { normalizeDroidArgs, parseAllowedTools } from "../../utils/parse-tools";
import { isEntityContext } from "../../github/context";
import { generateSecurityCandidatesPrompt } from "../../create-prompt/templates/security-review-prompt";
import type { Octokits } from "../../github/api/client";
import type { PrepareResult } from "../../prepare/types";
import { applyModelPolicyFallback } from "../../utils/model-policy";
import { resolveReviewConfig } from "../../utils/review-depth";
import { assertDroidRunType, DroidRunType } from "../../run-type";
import { githubReviewSessionTagArg } from "../../utils/review-session-tag";
import {
  prepareReviewLifecycle,
  readReviewLifecycle,
} from "../../github/operations/review-lifecycle";
import {
  automaticReviewSkipReason,
  reviewConfigFromEnvironment,
} from "../../core/review/config";

type SecurityReviewCommandOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  trackingCommentId?: number;
  runType?: DroidRunType | null;
  skipReason?: string;
};

export async function prepareSecurityReviewMode({
  context,
  octokit,
  githubToken,
  trackingCommentId,
  runType = DroidRunType.SecurityReview,
  skipReason: skipReasonOverride,
}: SecurityReviewCommandOptions): Promise<PrepareResult> {
  if (!isEntityContext(context)) {
    throw new Error("Security review command requires an entity event context");
  }

  if (!context.isPR) {
    throw new Error(
      "Security review command is only supported on pull requests",
    );
  }
  assertDroidRunType(runType, DroidRunType.SecurityReview);

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
  const config = context.inputs.reviewConfig ?? reviewConfigFromEnvironment();
  const draft =
    "pull_request" in context.payload && context.payload.pull_request.draft;
  const skipReason =
    skipReasonOverride ??
    automaticReviewSkipReason({
      config,
      draft: !!draft,
      eventAction: context.eventAction,
      manual: context.eventName !== "pull_request",
    });
  const lifecycle = await prepareReviewLifecycle({
    octokit,
    context,
    headSha: prData.headRefOid,
    trackingCommentId,
    securityOnly: true,
    full: context.eventName !== "pull_request",
    skipReason: skipReason ?? undefined,
  });
  const commentId = lifecycle.commentId;
  if (lifecycle.skipReason) {
    core.setOutput("run_code_review", "false");
    core.setOutput("run_security_review", "false");
    core.setOutput("steward_skipped", "true");
    return {
      skipped: true,
      reason: lifecycle.skipReason,
      commentId,
      branchInfo,
      mcpTools: "",
    };
  }

  const headRevision = await preparePullRequestHead({
    prNumber: context.entityNumber,
    isFork: prData.isFork,
    githubToken,
  });

  // Pre-compute review artifacts (diff, existing comments, and PR description)
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
    headRevision,
    incrementalBaseSha: lifecycle.incrementalBaseSha,
  });

  const artifactSkip = (await readReviewLifecycle())?.skipReason;
  if (artifactSkip) {
    core.setOutput("run_code_review", "false");
    core.setOutput("run_security_review", "false");
    core.setOutput("steward_skipped", "true");
    return {
      skipped: true,
      reason: artifactSkip,
      commentId,
      branchInfo,
      mcpTools: "",
    };
  }
  await createPrompt({
    githubContext: context,
    commentId,
    baseBranch: branchInfo.baseBranch,
    droidBranch: branchInfo.droidBranch,
    prBranchData: {
      headRefName: prData.headRefName,
      headRefOid: prData.headRefOid,
      isFork: prData.isFork,
      headRevision,
    },
    generatePrompt: generateSecurityCandidatesPrompt,
    reviewArtifacts,
  });
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
    "Edit",
    "Create",
    "ApplyPatch",
    "github_comment___update_droid_comment",
  ];

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

  const securityModelOverride = process.env.SECURITY_MODEL?.trim();
  const reviewConfig = resolveReviewConfig({
    reviewModel: process.env.REVIEW_MODEL?.trim(),
    reasoningEffort: process.env.REASONING_EFFORT?.trim(),
    reviewDepth: process.env.REVIEW_DEPTH?.trim(),
  });
  const {
    model: securityModel,
    reasoningEffort,
    fallbackNote,
  } = await applyModelPolicyFallback(
    {
      model: securityModelOverride || reviewConfig.model,
      reasoningEffort: securityModelOverride
        ? undefined
        : reviewConfig.reasoningEffort,
    },
    { flowLabel: "security review", modelInputName: "security_model" },
  );
  core.setOutput("review_model", securityModel || "auto");
  core.setOutput("review_reasoning_effort", reasoningEffort || "default");

  if (securityModel) {
    droidArgParts.push(`--model "${securityModel}"`);
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
  core.setOutput("droid_comment_id", commentId.toString());

  return {
    commentId,
    branchInfo,
    mcpTools,
  };
}
