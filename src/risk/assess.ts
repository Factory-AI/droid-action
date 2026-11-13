import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  buildRiskSnapshot,
  type createRiskEvidenceWorkspace,
  type fetchRiskPullRequest,
  type RiskEvidenceWorkspace,
} from "./evidence";
import {
  riskJudgeEnvironment,
  runRiskJudge,
  type RiskDroidInvocation,
} from "./judge";
import type { RiskJudgePlan } from "./plan";
import type { RiskRawAssessment } from "./publish";

export type RiskCli = { path: string; sha256: string };

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/**
 * The Droid executable the judge runs. When the review phase froze one
 * before its first model started, only those exact bytes are accepted. When
 * no review session ran in this job, the executable installed for the risk
 * phase is pinned here instead, before the judge starts.
 */
export async function resolveRiskCli(
  env: Record<string, string | undefined>,
): Promise<RiskCli> {
  const frozen = env.RISK_CLI_PATH?.trim();
  if (frozen) {
    const expected = env.RISK_CLI_SHA256?.trim() ?? "";
    if (!isAbsolute(frozen) || !/^[a-f0-9]{64}$/u.test(expected))
      throw new Error("The frozen Droid executable is not usable");
    // lstat, so a symlink swapped in for the frozen file is refused.
    if (!(await lstat(frozen)).isFile())
      throw new Error("The frozen Droid executable is not a regular file");
    if ((await sha256File(frozen)) !== expected)
      throw new Error("The Droid executable changed after it was frozen");
    return { path: frozen, sha256: expected };
  }
  const candidate =
    env.INPUT_PATH_TO_DROID_EXECUTABLE?.trim() ||
    (env.RUNNER_HOME ? join(env.RUNNER_HOME, ".local", "bin", "droid") : "");
  if (!candidate) throw new Error("Could not locate the Droid executable");
  const path = await realpath(candidate);
  return { path, sha256: await sha256File(path) };
}

export type RiskAssessInput = {
  plan: RiskJudgePlan;
  repo: string;
  pr: number;
  cli: RiskCli;
  /** The review phase's App token, revoked before the judge starts. */
  reviewToken?: string;
  /** A caller-provided token: used as it is and never revoked. */
  overrideToken?: string;
  apiUrl: string;
  serverUrl: string;
  parentDir: string;
  sourceRepoDir?: string;
  judgePath: string;
  factoryApiKey: string;
  factoryApiBaseUrl?: string;
};

export type RiskAssessDependencies = {
  revokeToken: (token: string) => Promise<void>;
  mintJudgeToken: () => Promise<string>;
  fetchPullRequest: typeof fetchRiskPullRequest;
  createEvidence: typeof createRiskEvidenceWorkspace;
  removeEvidence: (workDir: string) => Promise<void>;
  execute: (
    cliPath: string,
    invocation: RiskDroidInvocation,
  ) => Promise<string>;
  hashFile: (path: string) => Promise<string>;
};

export type RiskAssessResult =
  | { status: "stale_head" | "no_verdict" }
  | {
      status: "assessed";
      rawAssessment: RiskRawAssessment;
      droidCliVersion?: string;
    };

/**
 * Judges one planned head and returns the raw answer for the backend to
 * settle. The order is the point:
 *
 * 1. The review phase's token, which can write to the pull request, is
 *    revoked. If it cannot be, nothing is judged.
 * 2. A second token is minted from the same App, read-only. It is the only
 *    GitHub credential the judge session is given, and it is revoked when
 *    the run ends.
 * 3. Evidence is built for the plan's exact head, and the judge runs with
 *    an environment that holds nothing from the job.
 * 4. The executable is hashed again, so an answer produced by a binary
 *    that was swapped mid-run is discarded.
 */
export async function assessRisk(
  input: RiskAssessInput,
  dependencies: RiskAssessDependencies,
): Promise<RiskAssessResult> {
  const { plan } = input;
  const startedAt = Date.now();
  let judgeToken: string;
  let minted = false;
  if (input.overrideToken) {
    judgeToken = input.overrideToken;
  } else {
    if (input.reviewToken) await dependencies.revokeToken(input.reviewToken);
    judgeToken = await dependencies.mintJudgeToken();
    minted = true;
  }
  let evidence: RiskEvidenceWorkspace | undefined;
  try {
    const pullRequest = await dependencies.fetchPullRequest({
      repo: input.repo,
      pr: input.pr,
      token: judgeToken,
      apiUrl: input.apiUrl,
    });
    // The newer head's own run plans and judges that head.
    if (pullRequest.headSha !== plan.headSha) return { status: "stale_head" };
    const snapshot = buildRiskSnapshot(
      {
        repo: input.repo,
        prNumber: input.pr,
        title: pullRequest.title,
        baseSha: plan.baseSha,
        headSha: plan.headSha,
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
        changedFiles: pullRequest.changedFiles,
      },
      pullRequest.files,
      plan.priorDeclines,
    );
    evidence = await dependencies.createEvidence(snapshot, {
      parentDir: input.parentDir,
      remoteUrl: `${input.serverUrl}/${input.repo}.git`,
      sourceRepoDir: input.sourceRepoDir,
      auth: { token: judgeToken, serverUrl: input.serverUrl },
    });
    const env = riskJudgeEnvironment({
      evidence,
      path: input.judgePath,
      factoryApiKey: input.factoryApiKey,
      factoryApiBaseUrl: input.factoryApiBaseUrl,
      githubToken: judgeToken,
      repo: input.repo,
      group: plan.assignment.group,
    });
    const execute = (invocation: RiskDroidInvocation) =>
      dependencies.execute(input.cli.path, invocation);
    const droidCliVersion = await execute({
      args: ["--version"],
      cwd: evidence.rootDir,
      env,
      timeoutMs: 30_000,
    })
      .then((stdout) => stdout.trim().split("\n")[0]?.slice(0, 64) || undefined)
      .catch(() => undefined);
    const { verdict, attempts } = await runRiskJudge({
      judge: plan.judge,
      snapshot,
      evidence,
      env,
      execute,
    });
    if ((await dependencies.hashFile(input.cli.path)) !== input.cli.sha256)
      throw new Error("The Droid executable changed while the judge ran");
    for (const attempt of attempts)
      if (!attempt.valid)
        console.log(`Invalid judge answer: ${JSON.stringify(attempt)}`);
    if (!verdict) return { status: "no_verdict" };
    return {
      status: "assessed",
      rawAssessment: {
        headSha: plan.headSha,
        baseSha: plan.baseSha,
        snapshotHash: evidence.snapshotHash,
        assessedAt: new Date().toISOString(),
        assignment: plan.assignment,
        skillSha256: plan.judge.skillSha256,
        unlistedFiles: snapshot.summary.unlistedFiles,
        attempts,
        durationMs: Date.now() - startedAt,
        verdict,
      },
      ...(droidCliVersion ? { droidCliVersion } : {}),
    };
  } finally {
    if (evidence) await dependencies.removeEvidence(evidence.workDir);
    if (minted)
      await dependencies.revokeToken(judgeToken).catch(() => {
        console.log(
          "The judge token could not be revoked; it expires within the hour",
        );
      });
  }
}
