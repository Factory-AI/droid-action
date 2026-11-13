import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createPrRiskEvidenceWorkspace,
  removePrRiskEvidenceWorkspace,
} from "./evidence";
import { listPullRequestFiles } from "./github";
import {
  buildJudgeEnvironment,
  runPrRiskJudge,
  type RunPrRiskJudgeOptions,
} from "./judge";
import { describeFailure } from "./plan";
import { buildPrRiskSnapshot } from "./snapshot";
import {
  RiskError,
  failureReason,
  type PullRequestRiskFile,
  type RiskJudgeAttempt,
  type RiskPlan,
  type RiskSettleResult,
} from "./types";

const execFileAsync = promisify(execFile);

export type AssessPullRequestOptions = {
  plan: RiskPlan;
  /** A checkout of the repository; the exact base and head are fetched into it. */
  repoDir: string;
  /** Read-only token for the file list, the fetch, and the judge's `gh`. */
  githubToken: string | undefined;
  /** Overrides the API host of the judge session only. */
  judgeApiBaseUrl?: string;
  droidBinary?: string;
  env?: NodeJS.ProcessEnv;
  listFiles?: (input: {
    repo: string;
    pr: number;
    token: string;
  }) => Promise<PullRequestRiskFile[]>;
  executeDroid?: RunPrRiskJudgeOptions["executeDroid"];
};

/**
 * Judges the planned head and returns what to settle. Never throws: a run
 * that produced no verdict is itself a result, settled as `failed` under a
 * short reason so the head is not left looking unassessed.
 */
export async function assessPullRequest(
  options: AssessPullRequestOptions,
): Promise<RiskSettleResult> {
  const { plan } = options;
  const env = options.env ?? process.env;
  const attempts: RiskJudgeAttempt[] = [];
  const startedAt = Date.now();
  try {
    const token = options.githubToken;
    if (!token) {
      throw new RiskError(
        "github_token_missing",
        "No GitHub token is available to read the pull request",
      );
    }
    const files = await (options.listFiles ?? listPullRequestFiles)({
      repo: plan.repo,
      pr: plan.pr,
      token,
    });
    const snapshot = buildPrRiskSnapshot(
      {
        repo: plan.repo,
        prNumber: plan.pr,
        title: plan.pullRequest.title,
        baseSha: plan.baseSha,
        headSha: plan.headSha,
        additions: plan.pullRequest.additions,
        deletions: plan.pullRequest.deletions,
        changedFiles: plan.pullRequest.changedFiles,
      },
      files,
      plan.priorDeclines,
    );
    const evidence = await createPrRiskEvidenceWorkspace(snapshot, {
      repoDir: options.repoDir,
      githubToken: token,
    });
    try {
      let attemptStartedAt = Date.now();
      const verdict = await runPrRiskJudge(snapshot, {
        judge: plan.judge,
        evidence,
        env: buildJudgeEnvironment(
          {
            group: plan.judge.group,
            repo: plan.repo,
            githubToken: token,
            apiBaseUrl: options.judgeApiBaseUrl,
          },
          env,
        ),
        droidBinary: options.droidBinary,
        executeDroid: options.executeDroid,
        onAttempt: (attempt) => {
          const now = Date.now();
          attempts.push({ ...attempt, durationMs: now - attemptStartedAt });
          attemptStartedAt = now;
        },
      });
      const [first, ...rest] = attempts;
      if (!first) {
        throw new RiskError(
          "unexpected",
          "The judge answered without a recorded attempt",
        );
      }
      return {
        status: "judged",
        baseSha: plan.baseSha,
        judgeSha256: plan.judge.sha256,
        snapshotHash: evidence.snapshotHash,
        listedFiles: files.length,
        attempts: [first, ...rest],
        durationMs: Date.now() - startedAt,
        verdict: { ...verdict },
      };
    } finally {
      try {
        await removePrRiskEvidenceWorkspace(evidence);
      } catch (error) {
        // By now the judge has answered (or thrown on its own); a workspace
        // that cannot be deleted must not turn that answer into a failure.
        console.warn(
          `PR risk evidence workspace cleanup failed: ${describeFailure(error)}`,
        );
      }
    }
  } catch (error) {
    const reason = failureReason(error);
    console.warn(
      `PR risk assessment failed (${reason}): ${describeFailure(error)}`,
    );
    return {
      status: "failed",
      reason,
      ...(attempts.length > 0 ? { attempts } : {}),
      durationMs: Date.now() - startedAt,
    };
  }
}

/** The installed CLI's version, or undefined when it cannot be asked. */
export async function readDroidCliVersion(
  droidBinary = "droid",
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(droidBinary, ["--version"], {
      timeout: 15_000,
      env: {
        ...(env.PATH ? { PATH: env.PATH } : {}),
        ...(env.HOME ? { HOME: env.HOME } : {}),
      },
    });
    return stdout.trim().split("\n")[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}
