#!/usr/bin/env bun

/**
 * The judge step of the risk action. It reads the plan the begin step left,
 * fetches the plan's commits into the job's checkout, downloads the
 * `droid-review risk` worker this version names, and runs it on them. The
 * worker builds the evidence and runs the judge Factory served: on the whole
 * change, as a re-check of an earlier verdict, or both, as the plan asks.
 * What the worker reports becomes the result the settle step reads. It
 * always writes a result and always exits 0, so a run without a verdict is
 * still reported to Factory.
 */

import * as core from "@actions/core";
import {
  fetchRiskRevisions,
  removeCheckoutCredentials,
} from "../core/risk/checkout";
import {
  describeFailure,
  readRiskPlan,
  requiredEnv,
  riskPlanPath,
  riskResultPath,
  writePrivateJson,
} from "../core/risk/plan";
import {
  RISK_WORKER,
  RiskError,
  failureReason,
  type RiskResultFile,
  type RiskWorker,
} from "../core/risk/types";
import {
  buildWorkerInput,
  resultFileOf,
  runRiskWorker,
} from "../core/risk/worker";

async function assess(
  env: NodeJS.ProcessEnv,
  worker: RiskWorker,
  startedAt: number,
): Promise<RiskResultFile> {
  const plan = await readRiskPlan(riskPlanPath(env));
  const repoDir = requiredEnv("GITHUB_WORKSPACE", env);
  // Only the token the action passes in. The judge is handed whatever is
  // read here, and a `GITHUB_TOKEN` in the job's environment is the
  // caller's, which may write.
  const githubToken = env.GH_TOKEN?.trim();
  if (!githubToken) {
    throw new RiskError(
      "github_token_missing",
      "No GitHub token is available to read the pull request",
    );
  }
  const workerToken = env.RISK_WORKER_TOKEN?.trim();
  if (!workerToken) {
    throw new RiskError(
      "worker_unavailable",
      "The PR risk worker is downloaded with a token, and RISK_WORKER_TOKEN is empty",
    );
  }
  const policySha = await fetchRiskRevisions(plan, { repoDir, githubToken });
  await removeCheckoutCredentials(repoDir);
  const judgeApiBaseUrl = env.RISK_JUDGE_API_BASE_URL?.trim();
  const report = await runRiskWorker({
    worker,
    workerToken,
    repoDir,
    input: buildWorkerInput(plan, policySha),
    // The worker's whole environment. Its judge session runs pull request
    // code, so it gets the Factory credential, the read-only GitHub token,
    // and nothing else the job holds: not the token it was downloaded with.
    env: {
      ...(env.PATH ? { PATH: env.PATH } : {}),
      ...(env.HOME ? { HOME: env.HOME } : {}),
      ...(env.TMPDIR ? { TMPDIR: env.TMPDIR } : {}),
      DROID_BIN: env.DROID_BIN?.trim() || "droid",
      FACTORY_API_KEY: requiredEnv("FACTORY_API_KEY", env),
      GH_TOKEN: githubToken,
      ...(judgeApiBaseUrl ? { FACTORY_API_BASE_URL: judgeApiBaseUrl } : {}),
    },
  });
  return resultFileOf(report, plan, Date.now() - startedAt);
}

export async function run(
  env: NodeJS.ProcessEnv = process.env,
  worker: RiskWorker = RISK_WORKER,
): Promise<void> {
  const startedAt = Date.now();
  let file: RiskResultFile;
  try {
    file = await assess(env, worker, startedAt);
  } catch (error) {
    const reason = failureReason(error);
    core.warning(
      `PR risk assessment failed (${reason}): ${describeFailure(error)}`,
    );
    file = {
      result: { status: "failed", reason, durationMs: Date.now() - startedAt },
    };
  }
  await writePrivateJson(riskResultPath(env), file);

  // The verdict itself stays in the result file; the log only says whether
  // there is one.
  const { result, shadow } = file;
  console.log(
    result.status === "judged"
      ? `The PR risk judge answered after ${result.attempts.length} attempt(s).`
      : `No PR risk verdict (${result.reason}).`,
  );
  if (shadow) {
    console.log(
      shadow.status === "judged"
        ? `The shadow re-check answered after ${shadow.attempts.length} attempt(s).`
        : `No shadow re-check verdict (${shadow.reason}).`,
    );
  }
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(`PR risk assess failed: ${describeFailure(error)}`);
    process.exit(1);
  });
}
