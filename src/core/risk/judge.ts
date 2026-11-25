import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  fingerprintPrRiskEvidence,
  writePrRiskSettings,
  writePrRiskSkill,
} from "./evidence";
import { renderPrRiskSkill } from "./snapshot";
import {
  RISK_JUDGE_SKILL_NAME,
  RISK_SESSION_TAG,
  RISK_STAGE_SESSION_TAGS,
  RiskError,
  type PrRiskEvidenceWorkspace,
  type PullRequestRiskSnapshot,
  type RiskIncremental,
  type RiskJudge,
  type RiskJudgeAttempt,
  type RiskJudgeStage,
  type RiskScoreRanges,
  type RiskVerdictField,
} from "./types";
import {
  compilePrRiskVerdictSchema,
  describePrRiskContract,
  extractJsonCandidates,
  type PrRiskVerdict,
} from "./verdict";

const execFileAsync = promisify(execFile);
const MAX_DROID_OUTPUT_BYTES = 16 * 1024 * 1024;
const NO_RESULT_FEEDBACK = "<root>: the session produced no result";

/** The one JSON object `droid exec -o json` writes to stdout. */
const execSummarySchema = z
  .object({
    is_error: z.boolean(),
    result: z.string(),
    session_id: z.string().min(1).optional(),
  })
  .passthrough();

type PrRiskJudgeParse = { sessionId?: string } & (
  | { verdict: PrRiskVerdict }
  | {
      verdict?: undefined;
      invalidReason: NonNullable<RiskJudgeAttempt["invalidReason"]>;
      invalidPaths?: string[];
      invalidCodes?: string[];
      retryFeedback: string[];
    }
);

export type DroidRiskJudgeInvocation = {
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
};

export type RunPrRiskJudgeOptions = {
  judge: RiskJudge;
  evidence: PrRiskEvidenceWorkspace;
  /** The prior verdict to re-check, for an incremental judgment. */
  incremental?: RiskIncremental;
  /** The whole environment of the judge session; nothing else is inherited. */
  env: NodeJS.ProcessEnv;
  droidBinary?: string;
  onAttempt?: (attempt: RiskJudgeAttempt) => void;
  /**
   * Where the judge runs when a screen runs first: a second workspace built
   * from the same revisions before any session started, with the
   * `fingerprintPrRiskEvidence` digest taken then. Without it the screen is
   * not run.
   */
  confirm?: { evidence: PrRiskEvidenceWorkspace; fingerprint: string };
  executeDroid?: (input: DroidRiskJudgeInvocation) => Promise<string>;
};

/**
 * The judge session's environment: an allow-list. The session runs pull
 * request code, so it gets the Factory credential, the read-only GitHub token
 * `gh` uses, and nothing else the job holds: not the workflow token and not
 * the OIDC request credentials that could mint a broader one.
 */
export function buildJudgeEnvironment(
  input: {
    group: string;
    repo: string;
    githubToken?: string;
    apiBaseUrl?: string;
  },
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...(source.PATH ? { PATH: source.PATH } : {}),
    ...(source.HOME ? { HOME: source.HOME } : {}),
    ...(source.TMPDIR ? { TMPDIR: source.TMPDIR } : {}),
    ...(source.XDG_CONFIG_HOME
      ? { XDG_CONFIG_HOME: source.XDG_CONFIG_HOME }
      : {}),
    ...(source.FACTORY_API_KEY
      ? { FACTORY_API_KEY: source.FACTORY_API_KEY }
      : {}),
    ...(input.githubToken ? { GH_TOKEN: input.githubToken } : {}),
    GH_REPO: input.repo,
    ...(input.apiBaseUrl ? { FACTORY_API_BASE_URL: input.apiBaseUrl } : {}),
    DROID_EXEC_RUN_TYPE: input.group,
  };
}

/**
 * Validates one judge answer against the compiled contract. Feedback carries
 * schema codes and paths only: other Zod messages can echo rejected model
 * values, which are untrusted pull request content.
 */
function parsePrRiskJudgeOutput(
  stdout: string,
  scores: RiskScoreRanges,
  contract: { incremental: boolean; verdictField?: RiskVerdictField },
): PrRiskJudgeParse {
  let summary: z.infer<typeof execSummarySchema>;
  try {
    summary = execSummarySchema.parse(JSON.parse(stdout));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return {
        invalidReason: "exec_error",
        retryFeedback: [NO_RESULT_FEEDBACK],
      };
    }
    throw error;
  }
  const sessionId = summary.session_id;
  if (summary.is_error) {
    return {
      sessionId,
      invalidReason: "exec_error",
      retryFeedback: ["<root>: the session ended in an error"],
    };
  }
  const schema = compilePrRiskVerdictSchema(scores, contract);
  const trimmed = summary.result.trim();
  const candidates = new Set([
    ...(trimmed.startsWith("{") && trimmed.endsWith("}") ? [trimmed] : []),
    ...extractJsonCandidates(summary.result),
  ]);
  let schemaFailure: z.ZodError | undefined;
  for (const candidate of candidates) {
    let payload: unknown;
    try {
      payload = JSON.parse(candidate);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    const result = schema.safeParse(payload);
    if (result.success) return { sessionId, verdict: result.data };
    schemaFailure ??= result.error;
  }
  if (!schemaFailure) {
    return {
      sessionId,
      invalidReason: "no_json",
      retryFeedback: ["<root>: return exactly one JSON object"],
    };
  }
  const pathOf = (issue: z.ZodIssue) =>
    issue.path.length === 0 ? "<root>" : issue.path.join(".");
  return {
    sessionId,
    invalidReason: "schema",
    invalidPaths: [...new Set(schemaFailure.issues.map(pathOf))],
    invalidCodes: [...new Set(schemaFailure.issues.map((issue) => issue.code))],
    retryFeedback: schemaFailure.issues.map(
      (issue) => `${pathOf(issue)}: ${issue.code}`,
    ),
  };
}

async function executePrRiskDroid(
  args: readonly string[],
  evidence: PrRiskEvidenceWorkspace,
  options: RunPrRiskJudgeOptions,
): Promise<string> {
  const timeoutMs = options.judge.timeoutSeconds * 1000;
  if (options.executeDroid) {
    return options.executeDroid({
      args,
      cwd: evidence.rootDir,
      timeoutMs,
    });
  }
  try {
    return (
      await execFileAsync(options.droidBinary ?? "droid", args, {
        cwd: evidence.rootDir,
        timeout: timeoutMs,
        maxBuffer: MAX_DROID_OUTPUT_BYTES,
        env: options.env,
      })
    ).stdout;
  } catch (error) {
    // A non-zero exit still carries the JSON failure summary on stdout,
    // which is the attempt record; anything else is a real failure.
    if (
      error instanceof Error &&
      "stdout" in error &&
      typeof error.stdout === "string" &&
      error.stdout.trim().startsWith("{")
    ) {
      return error.stdout;
    }
    // `killed` is set only when execFile's own timeout sent the signal. The
    // exit shape after that varies (droid handles SIGTERM and exits 143; a
    // bare child dies with code null), so only the kill flag is trusted.
    if (error instanceof Error && "killed" in error && error.killed === true) {
      throw new RiskError("judge_timeout", "PR risk judge timed out");
    }
    // execFile's message quotes the session's stderr, which can repeat what
    // the judge was shown or said, so only the exit code is kept.
    const code = error instanceof Error && "code" in error ? error.code : null;
    throw new RiskError(
      "judge_exec_failed",
      `PR risk judge process failed${
        typeof code === "string" || typeof code === "number" ? ` (${code})` : ""
      }`,
    );
  }
}

/**
 * The judge's screen when this judgment runs one. A re-check, and a judge
 * decided by risk level alone, have no plain decline to stand on and skip it.
 */
export function prRiskScreenFor(
  judge: RiskJudge,
  incremental: RiskIncremental | undefined,
): RiskJudge["screen"] {
  return incremental === undefined && judge.verdictField !== "omitted"
    ? judge.screen
    : undefined;
}

/** One stage's session: where it runs, with what, and how it is labelled. */
type PrRiskJudgeInvocation = {
  evidence: PrRiskEvidenceWorkspace;
  skill: string;
  args: readonly string[];
  stage?: RiskJudgeStage;
};

/**
 * Runs the judge's skill against the exact-head workspace and returns the
 * answer validated against the compiled contract. The skill is the whole
 * prompt (`/pr-risk-judge`), its tools the whole tool surface, and its
 * settings the whole model configuration; head files and the complete diff
 * are data under `evidence/`, never ambient config. An answer that misses the
 * contract earns one strict retry naming the failed rules; the schema is
 * never weakened to rescue an invalid judgment.
 *
 * A judge served with a `screen` (see `prRiskScreenFor`) first runs the
 * skill once with the screen's tools and settings. A valid decline from it is
 * the verdict; anything else (an approval, an invalid answer, a failed
 * session) goes to the judge itself, so no approval rests on the screen. The
 * judge then runs in `confirm.evidence`, a second workspace built before the
 * screen ran, so nothing the screen's commands wrote reaches it, and only if
 * that workspace still matches the fingerprint taken when it was built.
 */
export async function runPrRiskJudge(
  snapshot: PullRequestRiskSnapshot,
  options: RunPrRiskJudgeOptions,
): Promise<PrRiskVerdict> {
  const { judge, evidence } = options;
  // Only a judge shown the prior verdict answers as a re-check.
  const incremental =
    options.incremental !== undefined && evidence.incremental !== undefined;
  const contract = { incremental, verdictField: judge.verdictField };
  const screen = options.confirm
    ? prRiskScreenFor(judge, options.incremental)
    : undefined;

  const invocation = async (
    at: PrRiskEvidenceWorkspace,
    run: Pick<RiskJudge, "enabledTools" | "settings">,
    stage: RiskJudgeStage | undefined,
  ): Promise<PrRiskJudgeInvocation> => ({
    evidence: at,
    skill: renderPrRiskSkill(judge.skill, snapshot, at, options.incremental),
    stage,
    args: [
      "--settings",
      await writePrRiskSettings(at, run.settings),
      "exec",
      // Exec ends the session outright on any command above its autonomy
      // level, so the level has to cover everything a verification does
      // (installs, builds, test runs). High still refuses destructive
      // commands.
      "--auto",
      "high",
      "--disable-builtin-skills",
      "--tag",
      RISK_SESSION_TAG,
      ...(stage ? ["--tag", RISK_STAGE_SESSION_TAGS[stage]] : []),
      "--only-tools",
      run.enabledTools.join(","),
      "--output-format",
      "json",
      "--cwd",
      at.rootDir,
      `/${RISK_JUDGE_SKILL_NAME}`,
    ],
  });

  const attempt = async (
    run: PrRiskJudgeInvocation,
    skillText: string,
  ): Promise<PrRiskJudgeParse> => {
    await writePrRiskSkill(run.evidence, skillText);
    const stage = run.stage ? { stage: run.stage } : {};
    let stdout: string;
    try {
      stdout = await executePrRiskDroid(run.args, run.evidence, options);
    } catch (error) {
      // A cascade records every session it started, so settle sees which
      // stage ran out of time or died even when the run fails.
      if (run.stage && error instanceof RiskError) {
        options.onAttempt?.({
          ...stage,
          valid: false,
          invalidReason: "exec_error",
          retryFeedback: [NO_RESULT_FEEDBACK],
        });
      }
      throw error;
    }
    const parsed = parsePrRiskJudgeOutput(stdout, judge.scores, contract);
    options.onAttempt?.({
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      ...stage,
      valid: parsed.verdict !== undefined,
      ...(parsed.verdict === undefined
        ? {
            invalidReason: parsed.invalidReason,
            ...(parsed.invalidPaths
              ? { invalidPaths: parsed.invalidPaths }
              : {}),
            ...(parsed.invalidCodes
              ? { invalidCodes: parsed.invalidCodes }
              : {}),
            retryFeedback: parsed.retryFeedback,
          }
        : {}),
    });
    return parsed;
  };

  let deciding: PrRiskJudgeInvocation;
  if (screen && options.confirm) {
    const screening = await invocation(evidence, screen, "screen");
    try {
      const screened = await attempt(screening, screening.skill);
      if (screened.verdict?.verdict === false) return screened.verdict;
    } catch (error) {
      // The judge still decides, so a screen that times out or dies costs
      // only its own run.
      if (!(error instanceof RiskError)) throw error;
    }
    if (
      (await fingerprintPrRiskEvidence(options.confirm.evidence)) !==
      options.confirm.fingerprint
    ) {
      throw new RiskError(
        "pr_risk_evidence_changed",
        "The PR risk judge's evidence changed while the screen ran",
      );
    }
    deciding = await invocation(options.confirm.evidence, judge, "confirm");
  } else {
    deciding = await invocation(evidence, judge, undefined);
  }

  const first = await attempt(deciding, deciding.skill);
  if (first.verdict) return first.verdict;

  const retry = await attempt(
    deciding,
    [
      deciding.skill.trimEnd(),
      "",
      "## Strict retry",
      "",
      "The previous attempt failed these validation rules:",
      ...first.retryFeedback.map((feedback) => `- ${feedback}`),
      "",
      "Return exactly one JSON object with exactly these keys and no others:",
      describePrRiskContract(judge.scores, contract),
      "",
      "Do not invent evidence or change a judgment to satisfy the contract; restate the same verdict in the required shape.",
      "",
    ].join("\n"),
  );
  if (retry.verdict) return retry.verdict;
  throw new RiskError(
    "invalid_pr_risk_verdict",
    "PR risk judge produced no valid verdict",
  );
}
