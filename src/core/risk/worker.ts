import { z } from "zod";
import {
  EVIDENCE_SECONDS,
  SESSION_STOP_SECONDS,
  endingsSchema,
  pathName,
  sessionSchema,
  type WorkerBounds,
} from "../worker/run";
import { StepError } from "../worker/step";
import {
  CommitShaSchema,
  RiskAnswerSchema,
  type RiskJudgeAttempt,
  type RiskPlan,
  type RiskResultFile,
  type RiskSettleResult,
} from "./types";

// The worker runs the judge at most twice (an answer that breaks the
// contract earns one more session), bounds each session by the judge's
// timeout, and can take `SESSION_STOP_SECONDS` again to stop a droid that
// ignores it.
const WORKER_SESSIONS = 2;
// An approving re-check's cited checks are run again within ten minutes,
// and one that ignores its stop is killed five seconds later.
const CITED_CHECKS_SECONDS = 605;

/** How long `droid-review risk` may run for a judge with this timeout. */
export function riskWorkerBounds(timeoutSeconds: number): WorkerBounds {
  const stopAfterMs =
    (WORKER_SESSIONS * (timeoutSeconds + SESSION_STOP_SECONDS) +
      EVIDENCE_SECONDS +
      CITED_CHECKS_SECONDS) *
    1000;
  return {
    stopAfterMs,
    killAfterMs: stopAfterMs + SESSION_STOP_SECONDS * 1000,
  };
}

/** What `droid-review risk` reads: the plan's facts it cannot compute from Git. */
type RiskWorkerInput = {
  repo: string;
  pr: number;
  title: string;
  base: string;
  head: string;
  /** The commit guidelines are read from. */
  policy: string;
  priorDeclines: RiskPlan["priorDeclines"];
  judge: RiskPlan["judge"];
  incremental?: RiskPlan["incremental"];
};

export function buildWorkerInput(
  plan: RiskPlan,
  policySha: string,
): RiskWorkerInput {
  return {
    repo: plan.repo,
    pr: plan.pr,
    title: plan.pullRequest.title,
    base: plan.baseSha,
    head: plan.headSha,
    policy: policySha,
    priorDeclines: plan.priorDeclines,
    judge: plan.judge,
    ...(plan.incremental ? { incremental: plan.incremental } : {}),
  };
}

const SessionSchema = sessionSchema({
  id: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
});
const judgment = { sessions: z.array(SessionSchema) };
/** One judgment: the sessions it ran, in order, and how it ended. */
const JudgmentSchema = z.discriminatedUnion("status", [
  ...endingsSchema(judgment, RiskAnswerSchema),
]);
type Judgment = z.infer<typeof JudgmentSchema>;

const worker = { worker: z.object({ droid: z.string() }) };
/**
 * The part of a `droid-review risk` report the settle step is told about. A
 * report about pinned commits is itself the judgment Factory publishes, and
 * `shadow` is the re-check the worker ran beside it when the plan asked for
 * one in shadow mode.
 */
export const RiskReportSchema = z.discriminatedUnion("status", [
  z.object({ ...worker, status: z.literal("unpinned") }),
  ...endingsSchema(
    {
      ...worker,
      ...judgment,
      revision: z.object({ base: CommitShaSchema, head: CommitShaSchema }),
      shadow: JudgmentSchema.optional(),
    },
    RiskAnswerSchema,
  ),
]);
type RiskReport = z.infer<typeof RiskReportSchema>;
/** One attempt record per session that started, in the order they ran. */
function attemptsOf(sessions: Judgment["sessions"]): RiskJudgeAttempt[] {
  return sessions.flatMap((session) => {
    if (!("id" in session)) return [];
    const attempt = {
      sessionId: session.id,
      valid: session.status === "answered",
      durationMs: session.durationMs,
    };
    if (session.status !== "invalid") return [attempt];
    const issues = session.issues.map(({ path, code }) => ({
      path: pathName(path),
      code,
    }));
    return [
      {
        ...attempt,
        invalidReason: "schema" as const,
        invalidPaths: [...new Set(issues.map(({ path }) => path))],
        invalidCodes: [...new Set(issues.map(({ code }) => code))],
        retryFeedback: issues.map(({ path, code }) => `${path}: ${code}`),
      },
    ];
  });
}

/** The reason Factory knows a judgment without an answer by. */
function failureOf(
  judgment: Exclude<Judgment, { status: "answered" }>,
): string {
  switch (judgment.status) {
    case "failed":
      return "judge_exec_failed";
    case "invalid":
      return "invalid_pr_risk_verdict";
    case "interrupted":
      return judgment.by === "deadline" ? "judge_timeout" : "judge_interrupted";
  }
}

/**
 * What the settle step is told of one judgment. Only an answer is a judged
 * result, sent under the names the worker gave it; every other ending is a
 * failure. Either way the attempts are that judgment's own sessions.
 */
function settledJudgment(
  judgment: Judgment,
  baseSha: string,
  durationMs: number,
): RiskSettleResult {
  const attempts = attemptsOf(judgment.sessions);
  if (judgment.status !== "answered") {
    return {
      status: "failed",
      reason: failureOf(judgment),
      ...(attempts.length > 0 ? { attempts } : {}),
      durationMs,
    };
  }
  const [first, ...rest] = attempts;
  if (!first) {
    throw new StepError(
      "worker_report_unreadable",
      "The PR risk worker's report holds an answer no session gave",
    );
  }
  return {
    status: "judged",
    baseSha,
    ...judgment.answer,
    attempts: [first, ...rest],
  };
}

/**
 * What the settle step is told for a report: its own judgment as the
 * result, and the re-check run beside it, when there is one, as the shadow.
 */
export function resultFileOf(
  report: RiskReport,
  plan: RiskPlan,
  durationMs: number,
): RiskResultFile {
  const version = report.worker.droid
    ? { droidCliVersion: report.worker.droid }
    : {};
  if (report.status === "unpinned") {
    return {
      ...version,
      result: { status: "failed", reason: "evidence_git_failed", durationMs },
    };
  }
  const { revision, shadow } = report;
  if (revision.head !== plan.headSha || revision.base !== plan.baseSha) {
    throw new StepError(
      "worker_report_unreadable",
      "The PR risk worker's report is not about the planned commits",
    );
  }
  return {
    ...version,
    result: settledJudgment(report, revision.base, durationMs),
    ...(shadow
      ? { shadow: settledJudgment(shadow, revision.base, durationMs) }
      : {}),
  };
}
