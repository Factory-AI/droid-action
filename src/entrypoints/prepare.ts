#!/usr/bin/env bun

/**
 * Prepare the Droid action by checking trigger conditions, verifying human actor,
 * and creating the initial tracking comment
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";
import { appTokenPermissionsFor } from "../github/token-permissions";
import { checkWritePermissions } from "../github/validation/permissions";
import { checkHumanActor } from "../github/validation/actor";
import { createOctokit } from "../github/api/client";
import {
  parseGitHubContext,
  isEntityContext,
  type GitHubContext,
} from "../github/context";
import { shouldTriggerTag } from "../tag";
import { prepare } from "../prepare";
import { collectActionInputsPresence } from "./collect-inputs";
import { initializeReviewConfig } from "../prepare/review-config";
import {
  freezeReviewRuntime,
  RISK_RUNTIME_KINDS,
} from "../prepare/review-runtime";
import {
  acknowledgeRiskRequest,
  planRun,
  publishRunPlan,
  readRiskRunInputs,
  replyRiskNeedsIdToken,
  riskRuntimeNeeded,
  warnRiskSkippedForWorkflow,
  type RiskRunInputs,
} from "../prepare/risk-run";

export async function run() {
  let context: GitHubContext | undefined;
  let riskInputs: RiskRunInputs | undefined;
  let runPlanPublished = false;
  try {
    collectActionInputsPresence();

    // Parse GitHub context first to enable mode detection
    context = parseGitHubContext();

    // Cleanup must be available even when authentication is followed by an
    // authorization failure, a missing trigger, or a preparation error.
    await freezeReviewRuntime();
    riskInputs = readRiskRunInputs();
    // The risk steps run after the review's model session, so their scripts
    // are frozen with the review's.
    if (riskRuntimeNeeded(riskInputs, context.eventName)) {
      await freezeReviewRuntime(RISK_RUNTIME_KINDS);
    }

    // Only the full action narrows its token. The prepare sub-action hands the
    // token to the caller's later steps, which may push or merge with it.
    const plannedRun = planRun(context, riskInputs);
    const githubToken = await setupGitHubToken(
      process.env.SCOPE_APP_TOKEN === "true"
        ? appTokenPermissionsFor(context)
        : undefined,
      {
        onWorkflowValidationSkip: () => warnRiskSkippedForWorkflow(plannedRun),
      },
    );
    core.setOutput("github_token", githubToken);
    const octokit = createOctokit(githubToken);

    // Step 3: Check write permissions (only for entity contexts)
    if (isEntityContext(context)) {
      // Check if github_token was provided as input (not from app)
      const githubTokenProvided = !!process.env.OVERRIDE_GITHUB_TOKEN;
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        githubTokenProvided,
      );
      if (!hasWritePermissions) {
        throw new Error(
          "Actor does not have write permissions to the repository",
        );
      }
    }

    await initializeReviewConfig(context, octokit);

    // After the write check: a comment's risk request is a manual request.
    const plan = planRun(context, riskInputs);
    if (plan.riskManual && isEntityContext(context)) {
      // Tag mode checks this before it acts on any other command.
      await checkHumanActor(octokit.rest, context);
    }
    const published = publishRunPlan(plan);
    runPlanPublished = true;

    if (plan.review === "off") {
      // The same exit as a run with no trigger, so every review step skips.
      core.setOutput("contains_trigger", "false");
      if (isEntityContext(context) && context.eventName === "issue_comment") {
        if (published.riskManual)
          await acknowledgeRiskRequest(octokit, context);
        else if (plan.riskManual && published.idTokenMissing)
          await replyRiskNeedsIdToken(octokit, context);
      }
      console.log("This run does not review, skipping the review steps");
      return;
    }
    if (plan.review === "manual") {
      context.inputs.manualReview = true;
    }

    // Check trigger conditions
    const containsTrigger = shouldTriggerTag(context);

    console.log(`Trigger result: ${containsTrigger}`);

    // Set output for action.yml to check
    core.setOutput("contains_trigger", containsTrigger.toString());

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      return;
    }

    // Step 5: Use the new modular prepare function
    const result = await prepare({
      context,
      octokit,
      githubToken,
    });

    // MCP config is handled by individual modes (tag/agent) and included in their droid_args output

    // Pass MCP tool config downstream for registration
    if (result?.mcpTools) {
      core.setOutput("mcp_tools", result.mcpTools);
    }
  } catch (error) {
    if (context && riskInputs && !runPlanPublished) {
      // The risk steps still run after a failed prepare, so Factory is told
      // the run failed and holds the assessment instead of leaving an
      // approval of an older commit standing. No manual request is made: the
      // failure may be the requester's write check.
      publishRunPlan(planRun(context, riskInputs, { requests: false }));
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Prepare step failed with error: ${errorMessage}`);
    // Also output the clean error message for the action to capture
    core.setOutput("prepare_error", errorMessage);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
