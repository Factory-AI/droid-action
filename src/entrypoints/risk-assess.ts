#!/usr/bin/env bun

/**
 * Judges one pull request head and writes what came of it.
 *
 * In the risk action it takes no arguments: it reads the plan the begin step
 * left, always writes a result for the settle step, and always exits 0, so a
 * failed judge is still reported to Factory.
 *
 * Offline it runs a judge file against a pull request without calling
 * Factory's risk endpoints:
 *
 *   bun run src/entrypoints/risk-assess.ts --judge <file> --repo <owner/name> \
 *     --pr <number> --repo-dir <checkout> [--out <dir>] [--droid-binary <path>]
 *
 * Both modes build a plan and hand it to the same assessment.
 */

import * as core from "@actions/core";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { assessPullRequest, readDroidCliVersion } from "../core/risk/assess";
import { getPullRequestSummary } from "../core/risk/github";
import {
  describeFailure,
  readRiskPlan,
  requiredEnv,
  riskPlanPath,
  riskResultPath,
  writePrivateJson,
} from "../core/risk/plan";
import {
  RISK_RUNNER,
  RiskError,
  RiskJudgeSchema,
  failureReason,
  type RiskPlan,
  type RiskResultFile,
} from "../core/risk/types";

const OFFLINE_USAGE =
  "Usage: risk-assess.ts --judge <file> --repo <owner/name> --pr <number> --repo-dir <checkout> [--out <dir>] [--droid-binary <path>]";
const OFFLINE_RESULT_FILE = "pr-risk-result.json";
const OFFLINE_TIMEOUT_SECONDS = 1800;

const OfflineJudgeSchema = RiskJudgeSchema.omit({ sha256: true }).extend({
  group: RiskJudgeSchema.shape.group.default("local"),
  timeoutSeconds: RiskJudgeSchema.shape.timeoutSeconds.default(
    OFFLINE_TIMEOUT_SECONDS,
  ),
});

type AssessInputs = {
  plan: RiskPlan;
  repoDir: string;
  resultPath: string;
  githubToken: string | undefined;
  droidBinary?: string;
  judgeApiBaseUrl?: string;
};

async function actionInputs(env: NodeJS.ProcessEnv): Promise<AssessInputs> {
  return {
    plan: await readRiskPlan(riskPlanPath(env)),
    repoDir: requiredEnv("GITHUB_WORKSPACE", env),
    resultPath: riskResultPath(env),
    // Only the token the action passes in. The judge is handed whatever is
    // read here, and a `GITHUB_TOKEN` in the job's environment is the
    // caller's, which may write.
    githubToken: env.GH_TOKEN?.trim() || undefined,
    droidBinary: env.DROID_BIN?.trim() || undefined,
    judgeApiBaseUrl: env.RISK_JUDGE_API_BASE_URL?.trim() || undefined,
  };
}

async function offlineInputs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<AssessInputs> {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        judge: { type: "string" },
        repo: { type: "string" },
        pr: { type: "string" },
        "repo-dir": { type: "string" },
        out: { type: "string" },
        "droid-binary": { type: "string" },
      },
    }));
  } catch {
    throw new RiskError("usage", OFFLINE_USAGE);
  }
  const { judge: judgePath, repo, pr } = values;
  const repoDir = values["repo-dir"];
  if (!judgePath || !repo || !repoDir || !pr || !/^[1-9][0-9]*$/.test(pr)) {
    throw new RiskError("usage", OFFLINE_USAGE);
  }
  const token = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new RiskError(
      "github_token_missing",
      "Set GH_TOKEN or GITHUB_TOKEN to a token that can read the pull request",
    );
  }

  const judgeBytes = await readFile(judgePath);
  let judge;
  try {
    judge = OfflineJudgeSchema.parse(JSON.parse(judgeBytes.toString("utf8")));
  } catch {
    throw new RiskError(
      "judge_file_invalid",
      "The judge file must be JSON with skill, enabledTools, settings and scores",
    );
  }
  const prNumber = Number(pr);
  return {
    plan: {
      repo,
      pr: prNumber,
      run: { runner: RISK_RUNNER, trigger: "local", dryRun: true },
      ...(await getPullRequestSummary({ repo, pr: prNumber, token })),
      priorDeclines: [],
      judge: {
        ...judge,
        sha256: createHash("sha256").update(judgeBytes).digest("hex"),
      },
    },
    repoDir: resolve(repoDir),
    resultPath: join(resolve(values.out ?? "."), OFFLINE_RESULT_FILE),
    githubToken: token,
    droidBinary: values["droid-binary"],
    judgeApiBaseUrl: env.FACTORY_API_BASE_URL?.trim() || undefined,
  };
}

export async function run(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const offline = argv.length > 0;
  let inputs: AssessInputs;
  try {
    inputs = offline ? await offlineInputs(argv, env) : await actionInputs(env);
  } catch (error) {
    if (offline) throw error;
    const reason = failureReason(error);
    core.warning(
      `PR risk assessment failed (${reason}): ${describeFailure(error)}`,
    );
    await writePrivateJson(riskResultPath(env), {
      result: { status: "failed", reason },
    } satisfies RiskResultFile);
    return;
  }

  const result = await assessPullRequest({
    plan: inputs.plan,
    repoDir: inputs.repoDir,
    githubToken: inputs.githubToken,
    judgeApiBaseUrl: inputs.judgeApiBaseUrl,
    droidBinary: inputs.droidBinary,
    env,
  });
  const droidCliVersion = await readDroidCliVersion(inputs.droidBinary, env);
  await writePrivateJson(inputs.resultPath, {
    ...(droidCliVersion ? { droidCliVersion } : {}),
    result,
  } satisfies RiskResultFile);

  // The verdict itself stays in the result file; the log only says whether
  // there is one.
  console.log(
    result.status === "judged"
      ? `The PR risk judge answered for ${inputs.plan.headSha} after ${result.attempts.length} attempt(s).`
      : `No PR risk verdict for ${inputs.plan.headSha} (${result.reason}).`,
  );
  if (offline) {
    console.log(`Result written to ${inputs.resultPath}`);
    if (result.status === "failed") process.exitCode = 1;
  }
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(`PR risk assess failed: ${describeFailure(error)}`);
    process.exit(1);
  });
}
