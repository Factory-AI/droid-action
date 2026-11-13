#!/usr/bin/env bun

/**
 * First step of the risk action: asks Factory what to do with this run's
 * pull request. When the answer is to judge it, the settle step is frozen
 * and what Factory served is written to an owner-only plan file for the
 * assess and settle steps. Nothing from that answer is printed.
 */

import * as core from "@actions/core";
import { rm } from "node:fs/promises";
import { beginRisk, getRiskOidcToken } from "../core/risk/client";
import { freezeRiskSettle } from "../core/risk/freeze";
import {
  buildRiskRun,
  describeFailure,
  parseFlag,
  parseReviewOutcome,
  readEvent,
  requiredEnv,
  resolveTarget,
  riskPlanPath,
  riskResultPath,
  writePrivateJson,
} from "../core/risk/plan";
import {
  RISK_DEFAULT_API_BASE_URL,
  RISK_UNKNOWN_ACTION,
  RISK_WORKFLOW_NOT_TRUSTED,
  type RiskPlan,
} from "../core/risk/types";

export async function run(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const repo = requiredEnv("GITHUB_REPOSITORY", env);
  const apiKey = requiredEnv("FACTORY_API_KEY", env);
  const dryRun = parseFlag(env.RISK_DRY_RUN);
  const manual = parseFlag(env.RISK_MANUAL);

  // An earlier use of the action in this job must not be settled again as
  // this run's answer.
  await rm(riskPlanPath(env), { force: true });
  await rm(riskResultPath(env), { force: true });

  const target = resolveTarget(
    env.RISK_PR_NUMBER,
    await readEvent(env.GITHUB_EVENT_PATH),
  );
  if (!target) {
    core.notice(
      "No pull request is associated with this event; nothing to assess.",
    );
    core.setOutput("action", "skip");
    return;
  }

  const reviewOutcome = parseReviewOutcome(env.RISK_REVIEW_OUTCOME);
  if (env.RISK_REVIEW_OUTCOME?.trim() && !reviewOutcome) {
    core.warning(
      "review_outcome is not one of success, failure, cancelled or skipped, so it was not reported.",
    );
  }

  const riskRun = buildRiskRun(dryRun, env);
  const response = await beginRisk(
    {
      repo,
      pr: target.pr,
      ...(target.eventHeadSha ? { eventHeadSha: target.eventHeadSha } : {}),
      ...(target.eventDraft ? { eventDraft: true } : {}),
      manual,
      ...(reviewOutcome ? { reviewOutcome } : {}),
      run: riskRun,
    },
    {
      baseUrl: env.RISK_API_BASE_URL?.trim() || RISK_DEFAULT_API_BASE_URL,
      apiKey,
      getOidcToken: () => getRiskOidcToken(dryRun, env),
    },
  );

  core.setOutput("action", response.action);
  if (response.action === "skip") {
    if (response.reason === RISK_UNKNOWN_ACTION) {
      core.warning(
        `Factory asked for something this version of the risk action does not know, so nothing was assessed for #${target.pr}. Update the action.`,
      );
    } else {
      core.notice(
        response.reason === RISK_WORKFLOW_NOT_TRUSTED
          ? `Factory does not accept PR risk requests from this workflow run (${RISK_WORKFLOW_NOT_TRUSTED}); nothing was assessed.`
          : `PR risk assessment skipped for #${target.pr} (${response.reason}).`,
      );
    }
    return;
  }

  core.setOutput("head_sha", response.headSha);
  if (response.action === "hold") {
    core.notice(
      `PR risk assessment for #${target.pr} is on hold (${response.reason}).`,
    );
    return;
  }

  // Frozen before the plan exists: a run whose settle step could not be
  // pinned never starts a judge.
  const frozen = await freezeRiskSettle();
  core.setOutput("settle_path", frozen.settlePath);
  core.setOutput("settle_sha256", frozen.settleSha256);
  core.setOutput("runtime_path", frozen.runtimePath);
  core.setOutput("runtime_sha256", frozen.runtimeSha256);

  const { action: _action, ...assignment } = response;
  const plan: RiskPlan = { repo, pr: target.pr, run: riskRun, ...assignment };
  await writePrivateJson(riskPlanPath(env), plan);
  console.log(
    `Factory asked for a PR risk assessment of #${target.pr} at ${response.headSha}.`,
  );
}

if (import.meta.main) {
  run().catch((error) => {
    core.setFailed(`PR risk begin failed: ${describeFailure(error)}`);
    process.exit(1);
  });
}
