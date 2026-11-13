#!/usr/bin/env bun

/**
 * Last step of the risk action: reports the judged head and what came of it
 * to Factory, which decides the outcome and publishes it on the pull request.
 * A run that left no result is reported too, so the head is marked
 * unavailable rather than left with a stale answer.
 */

import * as core from "@actions/core";
import { getRiskOidcToken, settleRisk } from "../core/risk/client";
import {
  buildSettleRequest,
  describeFailure,
  readRiskPlan,
  readRiskResult,
  requiredEnv,
  riskPlanPath,
  riskResultPath,
} from "../core/risk/plan";
import { RISK_DEFAULT_API_BASE_URL } from "../core/risk/types";

export async function run(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const plan = await readRiskPlan(riskPlanPath(env));
  const request = buildSettleRequest(
    plan,
    await readRiskResult(riskResultPath(env)),
  );
  const response = await settleRisk(request, {
    baseUrl: env.RISK_API_BASE_URL?.trim() || RISK_DEFAULT_API_BASE_URL,
    apiKey: requiredEnv("FACTORY_API_KEY", env),
    getOidcToken: () => getRiskOidcToken(plan.run.dryRun, env),
  });

  if (response.status === "stale_head") {
    core.notice(
      `The pull request moved past ${plan.headSha} while it was being assessed, so nothing was published; the run for the newer head owns the result.`,
    );
    core.setOutput("outcome", "stale_head");
    return;
  }

  core.setOutput("outcome", response.outcome);
  const reason =
    request.result.status === "failed"
      ? request.result.reason
      : response.reason;
  if (
    request.result.status === "failed" ||
    response.outcome === "unavailable"
  ) {
    core.setFailed(
      `PR risk assessment is unavailable for ${plan.headSha}${reason ? ` (${reason})` : ""}.`,
    );
    return;
  }
  const { comment, approval } = response.publication ?? {};
  console.log(
    [
      `PR risk outcome for ${plan.headSha}: ${response.outcome}.`,
      ...(comment ? [`Comment ${comment.action}.`] : []),
      ...(approval ? [`Approval: ${approval.action}.`] : []),
    ].join(" "),
  );
}

if (import.meta.main) {
  run().catch((error) => {
    core.setOutput("outcome", "failed");
    core.setFailed(`PR risk settle failed: ${describeFailure(error)}`);
    process.exit(1);
  });
}
