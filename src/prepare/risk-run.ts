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

export type RiskRunInputs = {
  /** Only the full action has risk steps; the prepare sub-action has none. */
  available: boolean;
  automaticRisk: boolean;
  run: RunMode;
  riskPrNumber: string;
};

export const ID_TOKEN_ERROR_TITLE = "Risk assessment needs id-token: write";

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

/**
 * Writes the plan as step outputs and returns the plan the risk steps will
 * follow. Without an OIDC token, begin would refuse after the review has
 * finished, so the assessment is dropped here and a later step fails the job.
 */
export function publishRunPlan(
  plan: RunPlan,
  env: NodeJS.ProcessEnv = process.env,
): RunPlan {
  let risk = plan.risk;
  let setupError = "";
  if (
    risk &&
    !env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim() &&
    !parseFlag(env.RISK_DRY_RUN)
  ) {
    setupError =
      'Add "id-token: write" under the job\'s permissions so Factory can verify this run, or stop requesting a risk assessment.';
    core.error(setupError, { title: ID_TOKEN_ERROR_TITLE });
    risk = false;
  }
  const riskManual = risk && plan.riskManual;
  core.setOutput("run_review", plan.review);
  core.setOutput("run_risk", String(risk));
  core.setOutput("risk_manual", String(riskManual));
  core.setOutput("run_reason", plan.reason);
  core.setOutput("risk_setup_error", setupError);
  console.log(`Run plan: ${plan.reason}`);
  return { ...plan, risk, riskManual };
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
