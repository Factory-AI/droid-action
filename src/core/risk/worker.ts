import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { writePrivateJson } from "./plan";
import {
  CommitShaSchema,
  RiskAnswerSchema,
  RiskError,
  type RiskJudgeAttempt,
  type RiskPlan,
  type RiskResultFile,
  type RiskSettleResult,
} from "./types";

const MAX_QUOTED_STDERR_CHARS = 1000;
// The worker runs the judge at most twice (an answer that breaks the
// contract earns one more session), bounds each session by the judge's
// timeout, and can take this long again to stop a droid that ignores it.
const WORKER_SESSIONS = 2;
const SESSION_STOP_SECONDS = 65;
// The worker's git commands have no time limit of their own.
const EVIDENCE_SECONDS = 600;
// An approving re-check's cited checks are run again within ten minutes,
// and one that ignores its stop is killed five seconds later.
const CITED_CHECKS_SECONDS = 605;

/** How long a worker may run before it is asked to stop, and then killed. */
type WorkerBounds = { stopAfterMs: number; killAfterMs: number };

function workerBounds(timeoutSeconds: number): WorkerBounds {
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

const StartedSessionSchema = z.object({
  id: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
});
const SessionSchema = z.union([
  z.object({ status: z.literal("failed"), problem: z.literal("start") }),
  StartedSessionSchema.extend({
    status: z.literal("failed"),
    problem: z.enum(["execution", "permission"]),
  }),
  StartedSessionSchema.extend({ status: z.literal("interrupted") }),
  StartedSessionSchema.extend({
    status: z.literal("invalid"),
    issues: z.array(
      z.object({
        path: z.array(z.union([z.string(), z.number()])),
        code: z.string(),
      }),
    ),
  }),
  StartedSessionSchema.extend({ status: z.literal("answered") }),
]);

/** The four ways a judgment ends, each beside `fields`. */
const endings = <Fields extends z.ZodRawShape>(fields: Fields) =>
  [
    z.object({ ...fields, status: z.literal("failed") }),
    z.object({
      ...fields,
      status: z.literal("interrupted"),
      by: z.enum(["deadline", "turns", "signal"]),
    }),
    z.object({ ...fields, status: z.literal("invalid") }),
    z.object({
      ...fields,
      status: z.literal("answered"),
      answer: RiskAnswerSchema,
    }),
  ] as const;

const judgment = { sessions: z.array(SessionSchema) };
/** One judgment: the sessions it ran, in order, and how it ended. */
const JudgmentSchema = z.discriminatedUnion("status", [...endings(judgment)]);
type Judgment = z.infer<typeof JudgmentSchema>;

const worker = { worker: z.object({ droid: z.string() }) };
/**
 * The part of a `droid-review risk` report the settle step is told about. A
 * report about pinned commits is itself the judgment Factory publishes, and
 * `shadow` is the re-check the worker ran beside it when the plan asked for
 * one in shadow mode.
 */
const RiskReportSchema = z.discriminatedUnion("status", [
  z.object({ ...worker, status: z.literal("unpinned") }),
  ...endings({
    ...worker,
    ...judgment,
    revision: z.object({ base: CommitShaSchema, head: CommitShaSchema }),
    shadow: JudgmentSchema.optional(),
  }),
]);
type RiskReport = z.infer<typeof RiskReportSchema>;

/** A place in a JSON value, as a failure names it. */
const pathName = (path: ReadonlyArray<string | number>) =>
  path.join(".") || "<root>";

/** The file the download step left, and the digest of the bytes to run. */
type DownloadedWorker = { path: string; sha256: string };

/**
 * The downloaded worker's bytes, when they are the ones `sha256` names. This
 * is the one place those bytes are checked, and what it returns is what is
 * run: a file changed after this read changes nothing.
 */
async function readWorker({ path, sha256 }: DownloadedWorker): Promise<Buffer> {
  const bytes = await readFile(path).catch(() => {
    throw new RiskError(
      "worker_unavailable",
      "The download step left no PR risk worker to run",
    );
  });
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new RiskError(
      "worker_unavailable",
      "The downloaded PR risk worker's bytes are not the ones this version runs",
    );
  }
  return bytes;
}

/**
 * Runs `droid-review risk` on a checkout that already holds the input's
 * commits, and returns the report it wrote. The worker is the file the
 * download step left, run only when its bytes have the digest named, under
 * the runtime this process runs under, with `env` as its whole environment.
 * Exit 0 and 1 are a report; anything else is a worker that left none,
 * whatever file may sit at the report's path. A worker that outlives every
 * bound it sets itself is asked to stop, which it answers with an
 * `interrupted` report, and then killed.
 */
export async function runRiskWorker(options: {
  worker: DownloadedWorker;
  repoDir: string;
  input: RiskWorkerInput;
  env: NodeJS.ProcessEnv;
  bounds?: WorkerBounds;
}): Promise<RiskReport> {
  const { stopAfterMs, killAfterMs } =
    options.bounds ?? workerBounds(options.input.judge.timeoutSeconds);
  const worker = await readWorker(options.worker);
  const dir = await mkdtemp(join(tmpdir(), "pr-risk-worker-"));
  try {
    const workerPath = join(dir, "droid-review.mjs");
    const inputPath = join(dir, "input.json");
    const reportPath = join(dir, "report.json");
    await writeFile(workerPath, worker, { mode: 0o600 });
    await writePrivateJson(inputPath, options.input);

    const child = spawn(
      process.execPath,
      [
        "--config=/dev/null",
        "--env-file=/dev/null",
        "run",
        workerPath,
        "risk",
        "--repo",
        options.repoDir,
        "--input",
        inputPath,
        "--report",
        reportPath,
      ],
      { cwd: dir, env: options.env, stdio: ["ignore", "ignore", "pipe"] },
    );
    const stop = setTimeout(() => child.kill("SIGTERM"), stopAfterMs);
    const kill = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    // What the worker says about itself. A judge session's own output never
    // reaches it: the worker's SDK keeps that to itself.
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_QUOTED_STDERR_CHARS);
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => {
      clearTimeout(stop);
      clearTimeout(kill);
    });
    if (exitCode !== 0 && exitCode !== 1) {
      throw new RiskError(
        "worker_no_report",
        `The PR risk worker left no report (exit ${exitCode}): ${stderr.trim()}`,
      );
    }
    // The report holds the judge's answer, so a failure to read it names
    // paths and codes, never the parser's own message, which can quote it.
    const report = await readFile(reportPath, "utf8").then(JSON.parse, () => {
      throw new RiskError(
        "worker_report_unreadable",
        "The PR risk worker's report could not be read",
      );
    });
    const parsed = RiskReportSchema.safeParse(report);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${pathName(issue.path)}: ${issue.code}`)
        .join(", ");
      throw new RiskError(
        "worker_report_unreadable",
        `The PR risk worker's report was not understood (${issues})`,
      );
    }
    return parsed.data;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
    throw new RiskError(
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
    throw new RiskError(
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
