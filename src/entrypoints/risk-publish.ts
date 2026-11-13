#!/usr/bin/env bun

/**
 * Last step of the risk phase: hands the head to the Factory backend, with
 * the judge's raw answer when there is one. The backend validates the
 * answer, decides the outcome, and performs every GitHub write.
 */

import * as core from "@actions/core";
import { z } from "zod";
import { riskApiFromEnv, riskRunIdentity } from "../risk/api";
import { readRiskHandoff } from "../risk/handoff";
import { publishRiskAssessment, type RiskRawAssessment } from "../risk/publish";

const handoffSchema = z.object({
  rawAssessment: z.object({ headSha: z.string() }).passthrough(),
  droidCliVersion: z.string().optional(),
});

export async function run(
  env: Record<string, string | undefined> = process.env,
  dependencies = { publish: publishRiskAssessment },
): Promise<void> {
  const repo = env.GITHUB_REPOSITORY?.trim();
  const pr = Number(env.RISK_PLAN_PR_NUMBER);
  const expectedHeadSha = env.RISK_PLAN_HEAD_SHA?.trim();
  if (!repo || !Number.isInteger(pr) || pr < 1 || !expectedHeadSha)
    throw new Error("There is no planned head to publish for");

  let rawAssessment: RiskRawAssessment | undefined;
  let droidCliVersion: string | undefined;
  if (env.RISK_ASSESS_STATUS === "assessed") {
    try {
      const handoff = handoffSchema.parse(
        await readRiskHandoff(
          env.RISK_ASSESSMENT_PATH,
          env.RISK_ASSESSMENT_SHA256,
        ),
      );
      if (handoff.rawAssessment.headSha !== expectedHeadSha)
        throw new Error("The assessment is for a different head");
      rawAssessment = handoff.rawAssessment as unknown as RiskRawAssessment;
      droidCliVersion = handoff.droidCliVersion;
    } catch (error) {
      core.warning(
        `The assessment could not be read back (${error instanceof Error ? error.message : "unknown error"}); publishing it as unavailable.`,
      );
    }
  }

  const response = await dependencies.publish(
    {
      repo,
      pr,
      expectedHeadSha,
      run: riskRunIdentity(env, { droidCliVersion }),
      ...(rawAssessment ? { rawAssessment } : {}),
    },
    riskApiFromEnv(env),
  );
  core.setOutput("status", response.status);
  if (response.status === "stale_head") {
    console.log(
      `Nothing was published: the pull request head is now ${response.headSha.slice(0, 12)}.`,
    );
    return;
  }
  const outcome =
    response.outcome ?? (rawAssessment ? "published" : "unavailable");
  const approval = response.publication.approval?.action ?? "untouched";
  core.setOutput("outcome", outcome);
  core.setOutput("reason", response.reason ?? "");
  core.setOutput("comment", response.publication.comment.action);
  core.setOutput("approval", approval);
  core.notice(
    `Risk assessment for ${expectedHeadSha.slice(0, 12)}: ${outcome}${response.reason ? ` (${response.reason})` : ""}; comment ${response.publication.comment.action}; approval ${approval}.`,
  );
}

if (import.meta.main)
  run().catch((error) => {
    core.setFailed(
      `Risk assessment was not published: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
