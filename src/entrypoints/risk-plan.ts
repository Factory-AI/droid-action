#!/usr/bin/env bun

/**
 * First step of the risk phase: asks the Factory backend what to do with
 * this pull request head. The backend answers skip, hold, or judge, and a
 * judge answer carries the judge to run. Nothing is decided here.
 */

import * as core from "@actions/core";
import { mkdtemp } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { riskApiFromEnv, riskRunIdentity } from "../risk/api";
import { writeRiskHandoff } from "../risk/handoff";
import { requestRiskPlan, resolveRiskPlanTarget } from "../risk/plan";

export async function run(
  env: Record<string, string | undefined> = process.env,
  dependencies = { requestPlan: requestRiskPlan },
): Promise<void> {
  const resolved = resolveRiskPlanTarget(env);
  if ("skip" in resolved) {
    console.log(`Risk assessment does not apply to this run: ${resolved.skip}`);
    core.setOutput("action", "skip");
    core.setOutput("reason", resolved.skip);
    return;
  }
  const { target } = resolved;
  const plan = await dependencies.requestPlan(
    target,
    riskRunIdentity(env),
    riskApiFromEnv(env),
  );
  core.setOutput("pr_number", String(target.pr));
  switch (plan.action) {
    case "skip":
    case "hold":
      console.log(
        `Risk assessment for #${target.pr}: ${plan.action} (${plan.reason})`,
      );
      core.setOutput("reason", plan.reason);
      break;
    case "unknown":
      core.warning(
        `The backend answered with a plan this action version cannot read (${plan.reportedAction ?? "no action"}); nothing is assessed.`,
      );
      break;
    case "judge": {
      const directory = await mkdtemp(
        join(env.RUNNER_TEMP || tmpdir(), "droid-risk-"),
      );
      const handoff = await writeRiskHandoff(directory, "plan.json", plan);
      console.log(
        `Risk assessment for #${target.pr}: judging ${plan.headSha.slice(0, 12)} with ${plan.assignment.group} (${plan.assignment.judgeConfig})`,
      );
      core.setOutput("head_sha", plan.headSha);
      core.setOutput("plan_path", handoff.path);
      core.setOutput("plan_sha256", handoff.sha256);
      break;
    }
  }
  core.setOutput("action", plan.action);
}

if (import.meta.main)
  run().catch((error) => {
    core.setOutput("action", "error");
    core.setFailed(
      `Risk assessment plan failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
