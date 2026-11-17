import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createPrRiskEvidenceWorkspace,
  removeCheckoutCredentials,
  removePrRiskEvidenceWorkspace,
} from "./evidence";
import {
  buildJudgeEnvironment,
  runPrRiskJudge,
  type RunPrRiskJudgeOptions,
} from "./judge";
import { rerunCitedChecks } from "./checks";
import { describeFailure } from "./plan";
import {
  RiskError,
  failureReason,
  type PrRiskEvidenceWorkspace,
  type RiskIncremental,
  type RiskJudgeAttempt,
  type RiskPlan,
  type RiskSettleResult,
} from "./types";

const execFileAsync = promisify(execFile);

export type AssessPullRequestOptions = {
  plan: RiskPlan;
  /** A checkout of the repository; the exact base and head are fetched into it. */
  repoDir: string;
  /** Read-only token for the fetch and the judge's `gh`. */
  githubToken: string | undefined;
  /**
   * Leaves the git credentials `repoDir` is configured with where they are.
   * Only for a clone that belongs to whoever runs the judge; a job's checkout
   * always has them removed before the judge starts.
   */
  keepCheckoutCredentials?: boolean;
  /** Overrides the API host of the judge session only. */
  judgeApiBaseUrl?: string;
  droidBinary?: string;
  env?: NodeJS.ProcessEnv;
  executeDroid?: RunPrRiskJudgeOptions["executeDroid"];
};

/** What one assessment leaves to settle. */
type RiskAssessment = {
  result: RiskSettleResult;
  shadow?: RiskSettleResult;
};

/**
 * Judges the planned head and returns what to settle. Never throws: a run
 * that produced no verdict is itself a result, settled as `failed` under a
 * short reason so the head is not left looking unassessed.
 *
 * A plan whose incremental re-check is in shadow mode is judged afresh as
 * usual, and the re-check runs alongside in its own workspace. Its result is
 * returned as `shadow`; a failure there never touches the primary result.
 */
export async function assessPullRequest(
  options: AssessPullRequestOptions,
): Promise<RiskAssessment> {
  const { plan } = options;
  const shadowed =
    plan.incremental?.mode === "shadow" ? plan.incremental : undefined;
  const primary = await prepareJudgment(
    options,
    shadowed ? undefined : plan.incremental,
  );
  // Prepared one after the other: both fetch into the same checkout.
  const shadow =
    shadowed && "prepared" in primary
      ? await prepareJudgment(options, shadowed)
      : undefined;
  const [result, shadowResult] = await Promise.all([
    finishJudgment(options, primary),
    shadow ? finishJudgment(options, shadow) : undefined,
  ]);
  return { result, ...(shadowResult ? { shadow: shadowResult } : {}) };
}

type PreparedJudgment = Awaited<
  ReturnType<typeof createPrRiskEvidenceWorkspace>
> & { token: string; incremental?: RiskIncremental };

type JudgmentStart = { startedAt: number } & (
  | { prepared: PreparedJudgment }
  | { failure: unknown }
);

async function prepareJudgment(
  options: AssessPullRequestOptions,
  incremental: RiskIncremental | undefined,
): Promise<JudgmentStart> {
  const { plan } = options;
  const startedAt = Date.now();
  try {
    const token = options.githubToken;
    if (!token) {
      throw new RiskError(
        "github_token_missing",
        "No GitHub token is available to read the pull request",
      );
    }
    const built = await createPrRiskEvidenceWorkspace(
      {
        repo: plan.repo,
        prNumber: plan.pr,
        title: plan.pullRequest.title,
        baseSha: plan.baseSha,
        headSha: plan.headSha,
      },
      {
        repoDir: options.repoDir,
        githubToken: token,
        priorDeclines: plan.priorDeclines,
        incremental,
      },
    );
    if (!options.keepCheckoutCredentials) {
      try {
        await removeCheckoutCredentials(
          options.repoDir,
          built.evidence.headTreeDir,
        );
      } catch (error) {
        await removeWorkspace(built.evidence);
        throw error;
      }
    }
    return { startedAt, prepared: { ...built, token, incremental } };
  } catch (failure) {
    return { startedAt, failure };
  }
}

async function removeWorkspace(
  evidence: PrRiskEvidenceWorkspace,
): Promise<void> {
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

async function finishJudgment(
  options: AssessPullRequestOptions,
  start: JudgmentStart,
): Promise<RiskSettleResult> {
  const { plan } = options;
  const env = options.env ?? process.env;
  const attempts: RiskJudgeAttempt[] = [];
  const { startedAt } = start;
  try {
    if ("failure" in start) throw start.failure;
    const { snapshot, evidence, incrementalFallback, token, incremental } =
      start.prepared;
    try {
      let attemptStartedAt = Date.now();
      const verdict = await runPrRiskJudge(snapshot, {
        judge: plan.judge,
        evidence,
        incremental,
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
      // Only an enforced approval is published on the strength of its
      // checks, so only its checks are run again.
      const checkRuns =
        incremental?.mode === "enforce" &&
        evidence.incremental &&
        verdict.verdict &&
        verdict.checks?.length
          ? await rerunCitedChecks({
              repoDir: options.repoDir,
              headSha: plan.headSha,
              evidence,
              checks: verdict.checks,
              changedPaths: evidence.incremental.focus.paths.map(
                ({ path }) => path,
              ),
              env,
            })
          : undefined;
      return {
        status: "judged",
        baseSha: plan.baseSha,
        judgeSha256: plan.judge.sha256,
        snapshotHash: evidence.snapshotHash,
        guidelinesBlobSha: evidence.guidelinesBlobSha,
        listedFiles: snapshot.files.length,
        attempts: [first, ...rest],
        durationMs: Date.now() - startedAt,
        verdict: { ...verdict },
        ...(incremental
          ? {
              mode: evidence.incremental ? "incremental" : "full",
              priorHeadSha: incremental.priorHeadSha,
              ...(incremental.priorAssessmentId
                ? { priorAssessmentId: incremental.priorAssessmentId }
                : {}),
              ...(incrementalFallback ? { incrementalFallback } : {}),
            }
          : {}),
        ...(checkRuns ? { checkRuns } : {}),
      };
    } finally {
      await removeWorkspace(evidence);
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
