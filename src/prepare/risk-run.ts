import * as core from "@actions/core";
import { reviewConfigFromEnvironment } from "../core/review/config";
import { parseFlag } from "../core/risk/plan";
import {
  parseRunMode,
  resolveRunPlan,
  type RunMode,
  type RunPlan,
} from "../core/risk/run-plan";
import type { Octokits } from "../github/api/client";
import { isEntityContext, type GitHubContext } from "../github/context";
import type { ParsedGitHubContext } from "../github/context";
import { addEyesReaction } from "../github/operations/review-lifecycle";
import { extractCommandFromContext } from "../github/utils/command-parser";
import { replyToPullRequestComment } from "../github/operations/comments/reply";

export type RiskRunInputs = {
  /** Only the full action has risk steps; the prepare sub-action has none. */
  available: boolean;
  automaticRisk: boolean;
  run: RunMode;
  riskPrNumber: string;
};

export const ID_TOKEN_WARNING_TITLE =
  "Risk assessment skipped: needs id-token: write";
export const ID_TOKEN_REPLY =
  "The risk assessment couldn't start: the workflow job needs `permissions: id-token: write`.";

export const WORKFLOW_DIFFERS_WARNING_TITLE =
  "Risk assessment skipped: workflow file differs from the default branch";

/** Reads the inputs that decide what runs. An unknown `run` value throws. */
export function readRiskRunInputs(
  env: NodeJS.ProcessEnv = process.env,
): RiskRunInputs {
  const available = parseFlag(env.RISK_STEPS_AVAILABLE);
  if (!available)
    return { available, automaticRisk: false, run: "auto", riskPrNumber: "" };
  const run = parseRunMode(env.RUN_MODE);
  const alias = env.RISK_ASSESSMENT?.trim() ?? "";
  if (alias)
    core.warning(
      "risk_assessment is deprecated; use automatic_risk_assessment",
    );
  return {
    available,
    automaticRisk: parseFlag(env.AUTOMATIC_RISK_ASSESSMENT) || parseFlag(alias),
    run,
    riskPrNumber: env.RISK_PR_NUMBER?.trim() ?? "",
  };
}

/**
 * Whether this run may assess risk, so prepare freezes the risk scripts. A
 * comment or a dispatch can ask for an assessment whatever the automatic
 * setting says.
 */
export function riskRuntimeNeeded(
  inputs: RiskRunInputs,
  eventName: string,
): boolean {
  return (
    inputs.automaticRisk ||
    (inputs.available &&
      (eventName === "issue_comment" || eventName === "workflow_dispatch"))
  );
}

/**
 * The run plan for this event. Without `requests`, or where the action has
 * no risk steps, comment commands and risk_pr_number are ignored, so no
 * manual request is made.
 */
export function planRun(
  context: GitHubContext,
  inputs: RiskRunInputs,
  { requests = true }: { requests?: boolean } = {},
): RunPlan {
  requests &&= inputs.available;
  const payload = context.payload as
    | { pull_request?: { draft?: boolean } }
    | undefined;
  return resolveRunPlan({
    automaticRisk: inputs.automaticRisk,
    run: inputs.run,
    eventName: context.eventName,
    eventAction: context.eventAction,
    isPR: isEntityContext(context) && context.isPR,
    isDraft: payload?.pull_request?.draft === true,
    command: requests
      ? (extractCommandFromContext(context) ?? undefined)
      : undefined,
    riskPrNumber: requests ? inputs.riskPrNumber : undefined,
  });
}

export type PublishedRunPlan = RunPlan & {
  /** The plan asked for an assessment the job cannot authenticate. */
  idTokenMissing: boolean;
};

/**
 * Writes the plan as step outputs and returns the plan the risk steps will
 * follow. Without an OIDC token, begin would refuse after the review has
 * finished, so the assessment is skipped here with a warning; the review and
 * the job are unaffected.
 */
export function publishRunPlan(
  plan: RunPlan,
  env: NodeJS.ProcessEnv = process.env,
): PublishedRunPlan {
  const idTokenMissing =
    plan.risk &&
    !env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim() &&
    !parseFlag(env.RISK_DRY_RUN);
  if (idTokenMissing)
    core.warning(
      'Add "id-token: write" under the job\'s permissions so Factory can verify this run. The review is not affected.',
      { title: ID_TOKEN_WARNING_TITLE },
    );
  const risk = plan.risk && !idTokenMissing;
  const riskManual = risk && plan.riskManual;
  core.setOutput("run_review", plan.review);
  core.setOutput("run_risk", String(risk));
  core.setOutput("risk_manual", String(riskManual));
  core.setOutput("run_reason", plan.reason);
  console.log(`Run plan: ${plan.reason}`);
  return { ...plan, risk, riskManual, idTokenMissing };
}

/**
 * Factory exchanges a token only for a workflow file that matches the default
 * branch's copy, and the action exits before begin when it does not. Without
 * this warning the only trace is the generic validation skip, which does not
 * say an assessment was wanted.
 */
export function warnRiskSkippedForWorkflow(plan: RunPlan): void {
  if (!plan.risk) return;
  core.warning(
    "Factory assesses risk only when this workflow file matches its copy on the default branch, and this pull request changes it. No assessment ran and nothing was approved. Runs after the change reaches the default branch are assessed.",
    { title: WORKFLOW_DIFFERS_WARNING_TITLE },
  );
}

/** Tells the requester why their PR comment's assessment did not start. */
export async function replyRiskNeedsIdToken(
  octokit: Octokits,
  context: ParsedGitHubContext,
): Promise<void> {
  try {
    await replyToPullRequestComment({
      octokit,
      ...context.repository,
      prNumber: context.entityNumber,
      commentId: 0,
      body: ID_TOKEN_REPLY,
      type: "issue",
    });
  } catch (error) {
    core.warning(
      `Could not reply to the risk request: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The eyes reaction tag mode gives a command, for a comment's risk request. */
export async function acknowledgeRiskRequest(
  octokit: Octokits,
  context: ParsedGitHubContext,
): Promise<void> {
  const config = context.inputs.reviewConfig ?? reviewConfigFromEnvironment();
  if (!config.review_reactions || context.eventName !== "issue_comment") return;
  await addEyesReaction(octokit, context, (message) => core.warning(message));
}
