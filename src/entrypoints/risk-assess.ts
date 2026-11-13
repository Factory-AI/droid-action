#!/usr/bin/env bun

/**
 * Second step of the risk phase: runs the planned judge against the exact
 * head and writes its raw answer for the publish step. See `assessRisk` for
 * what is locked down before the judge starts.
 */

import * as core from "@actions/core";
import { dirname } from "path";
import { revokeGitHubAppToken } from "../github/token";
import {
  assessRisk,
  resolveRiskCli,
  sha256File,
  type RiskAssessDependencies,
} from "../risk/assess";
import {
  createRiskEvidenceWorkspace,
  fetchRiskPullRequest,
  removeRiskEvidenceWorkspace,
} from "../risk/evidence";
import { readRiskHandoff, writeRiskHandoff } from "../risk/handoff";
import { executeRiskDroid } from "../risk/judge";
import { parseRiskPlan } from "../risk/plan";
import { mintJudgeToken } from "../risk/token";

const defaultDependencies: RiskAssessDependencies = {
  revokeToken: revokeGitHubAppToken,
  mintJudgeToken,
  fetchPullRequest: fetchRiskPullRequest,
  createEvidence: createRiskEvidenceWorkspace,
  removeEvidence: removeRiskEvidenceWorkspace,
  execute: executeRiskDroid,
  hashFile: sha256File,
};

export async function run(
  env: Record<string, string | undefined> = process.env,
  dependencies: RiskAssessDependencies = defaultDependencies,
): Promise<void> {
  const plan = parseRiskPlan(
    await readRiskHandoff(env.RISK_PLAN_PATH, env.RISK_PLAN_SHA256),
  );
  const pr = Number(env.RISK_PLAN_PR_NUMBER);
  const repo = env.GITHUB_REPOSITORY?.trim();
  const factoryApiKey = env.FACTORY_API_KEY?.trim();
  if (plan.action !== "judge" || !Number.isInteger(pr) || pr < 1 || !repo)
    throw new Error("There is no judge plan to assess");
  if (!factoryApiKey)
    throw new Error("A Factory API key is required for risk assessment");
  const result = await assessRisk(
    {
      plan,
      repo,
      pr,
      cli: await resolveRiskCli(env),
      reviewToken: env.REVIEW_GITHUB_TOKEN?.trim() || undefined,
      overrideToken: env.OVERRIDE_GITHUB_TOKEN?.trim() || undefined,
      apiUrl: env.GITHUB_API_URL || "https://api.github.com",
      serverUrl: env.GITHUB_SERVER_URL || "https://github.com",
      parentDir: dirname(env.RISK_PLAN_PATH!),
      sourceRepoDir: env.GITHUB_WORKSPACE?.trim() || undefined,
      judgePath: env.RISK_JUDGE_PATH?.trim() || "/usr/local/bin:/usr/bin:/bin",
      factoryApiKey,
      factoryApiBaseUrl: env.FACTORY_API_BASE_URL?.trim() || undefined,
    },
    dependencies,
  );
  if (result.status === "assessed") {
    const { status: _status, ...assessment } = result;
    const handoff = await writeRiskHandoff(
      dirname(env.RISK_PLAN_PATH!),
      "assessment.json",
      assessment,
    );
    core.setOutput("assessment_path", handoff.path);
    core.setOutput("assessment_sha256", handoff.sha256);
    console.log(
      `The judge answered after ${result.rawAssessment.attempts.length} attempt(s).`,
    );
  } else if (result.status === "no_verdict") {
    core.warning("The risk judge produced no valid verdict.");
  } else {
    console.log("The pull request moved past the planned head; not judging.");
  }
  core.setOutput("status", result.status);
}

if (import.meta.main)
  run().catch((error) => {
    core.setOutput("status", "failed");
    core.setFailed(
      `Risk assessment failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
