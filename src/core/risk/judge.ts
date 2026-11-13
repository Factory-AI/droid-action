import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { writePrRiskSettings, writePrRiskSkill } from "./evidence";
import { renderPrRiskSkill } from "./snapshot";
import {
  RISK_JUDGE_SKILL_NAME,
  RISK_SESSION_TAG,
  RiskError,
  type PrRiskEvidenceWorkspace,
  type PullRequestRiskSnapshot,
  type RiskJudge,
  type RiskJudgeAttempt,
  type RiskScoreRanges,
} from "./types";
import {
  compilePrRiskVerdictSchema,
  describePrRiskContract,
  extractJsonCandidates,
  type PrRiskVerdict,
} from "./verdict";

const execFileAsync = promisify(execFile);
const MAX_DROID_OUTPUT_BYTES = 16 * 1024 * 1024;

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
  /** The whole environment of the judge session; nothing else is inherited. */
  env: NodeJS.ProcessEnv;
  droidBinary?: string;
  onAttempt?: (attempt: RiskJudgeAttempt) => void;
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
): PrRiskJudgeParse {
  let summary: z.infer<typeof execSummarySchema>;
  try {
    summary = execSummarySchema.parse(JSON.parse(stdout));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return {
        invalidReason: "exec_error",
        retryFeedback: ["<root>: the session produced no result"],
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
  const schema = compilePrRiskVerdictSchema(scores);
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
  options: RunPrRiskJudgeOptions,
): Promise<string> {
  const timeoutMs = options.judge.timeoutSeconds * 1000;
  if (options.executeDroid) {
    return options.executeDroid({
      args,
      cwd: options.evidence.rootDir,
      timeoutMs,
    });
  }
  try {
    return (
      await execFileAsync(options.droidBinary ?? "droid", args, {
        cwd: options.evidence.rootDir,
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
 * Runs the judge's skill against the exact-head workspace and returns the
 * answer validated against the compiled contract. The skill is the whole
 * prompt (`/pr-risk-judge`), its tools the whole tool surface, and its
 * settings the whole model configuration; head files and the complete diff
 * are data under `evidence/`, never ambient config. An answer that misses the
 * contract earns one strict retry naming the failed rules; the schema is
 * never weakened to rescue an invalid judgment.
 */
export async function runPrRiskJudge(
  snapshot: PullRequestRiskSnapshot,
  options: RunPrRiskJudgeOptions,
): Promise<PrRiskVerdict> {
  const { judge, evidence } = options;
  const skill = renderPrRiskSkill(judge.skill, snapshot, evidence);
  const settingsPath = await writePrRiskSettings(evidence, judge.settings);
  const args = [
    "--settings",
    settingsPath,
    "exec",
    // Exec ends the session outright on any command above its autonomy
    // level, so the level has to cover everything a verification does
    // (installs, builds, test runs). High still refuses destructive commands.
    "--auto",
    "high",
    "--disable-builtin-skills",
    "--tag",
    RISK_SESSION_TAG,
    "--only-tools",
    judge.enabledTools.join(","),
    "--output-format",
    "json",
    "--cwd",
    evidence.rootDir,
    `/${RISK_JUDGE_SKILL_NAME}`,
  ];

  const attempt = async (skillText: string): Promise<PrRiskJudgeParse> => {
    await writePrRiskSkill(evidence, skillText);
    const parsed = parsePrRiskJudgeOutput(
      await executePrRiskDroid(args, options),
      judge.scores,
    );
    options.onAttempt?.({
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
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

  const first = await attempt(skill);
  if (first.verdict) return first.verdict;

  const retry = await attempt(
    [
      skill.trimEnd(),
      "",
      "## Strict retry",
      "",
      "The previous attempt failed these validation rules:",
      ...first.retryFeedback.map((feedback) => `- ${feedback}`),
      "",
      "Return exactly one JSON object with exactly these keys and no others:",
      describePrRiskContract(judge.scores),
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
