import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  renderRiskSkill,
  RISK_JUDGE_SKILL_NAME,
  type RiskEvidenceWorkspace,
  type RiskSnapshot,
} from "./evidence";
import type { RiskJudgePlan } from "./plan";

const execFileAsync = promisify(execFile);
const MAX_DROID_OUTPUT_BYTES = 16 * 1024 * 1024;
const SESSION_TAG = "riskAssessment";
// The publish route refuses a body past 256 KiB, and a verdict near that
// size is not a brief and a details drawer.
const MAX_VERDICT_BYTES = 128 * 1024;

/** Validation result of one judge session, as the backend records it. */
export type RiskJudgeAttempt = {
  sessionId?: string;
  valid: boolean;
  durationMs: number;
  invalidReason?: "exec_error" | "no_json" | "schema";
  invalidPaths?: string[];
  invalidCodes?: string[];
  /** Schema codes and paths only; never rejected model values. */
  retryFeedback?: string[];
};

export type RiskDroidInvocation = {
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
};

export class RiskJudgeTimeoutError extends Error {
  constructor(timeoutSeconds: number) {
    super(`The risk judge did not answer within ${timeoutSeconds} seconds`);
    this.name = "RiskJudgeTimeoutError";
  }
}

/** The one JSON object `droid exec -o json` writes to stdout. */
const execSummarySchema = z.object({
  is_error: z.boolean(),
  result: z.string(),
  session_id: z.string().min(1).optional(),
});

type JudgeParse = { sessionId?: string } & (
  | { verdict: Record<string, unknown> }
  | {
      verdict?: undefined;
      invalidReason: NonNullable<RiskJudgeAttempt["invalidReason"]>;
      invalidPaths?: string[];
      invalidCodes?: string[];
      retryFeedback: string[];
    }
);

/**
 * The shape a judge answer must have before it is worth sending: `verdict`,
 * `brief`, `details`, and every declared score inside its range, and
 * nothing else. This is a shape check only. Whether the verdict stands is
 * decided by the backend, which validates it again and holds the thresholds.
 */
function verdictShape(scores: RiskJudgePlan["judge"]["scores"]) {
  const core = z.object({
    verdict: z.boolean(),
    brief: z.string().min(1),
    details: z.string().min(1),
  });
  const entries = Object.entries(scores);
  if (entries.length === 0) return core.strict();
  return core
    .extend({
      scores: z
        .object(
          Object.fromEntries(
            entries.map(([name, [min, max]]) => [
              name,
              z.number().int().min(min).max(max),
            ]),
          ),
        )
        .strict(),
    })
    .strict();
}

const FENCED_JSON_OPENER = /```json[ \t]*\r?\n[ \t\r\n]*/g;

/**
 * The object opening at `openIndex`, or null when it never balances. The
 * scan is JSON-string-aware so braces inside quoted values do not skew the
 * depth.
 */
function balancedObjectAt(text: string, openIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openIndex; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (inString) {
      if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return text.slice(openIndex, index + 1);
    }
  }
  return null;
}

/**
 * JSON candidates from a session's final message, most authoritative
 * first: the whole message when it is one object, fenced json blocks in
 * reverse order, then the last balanced object and the objects enclosing
 * it. A fenced block is read by balancing its object, not by searching for
 * the closing fence, because a verdict may quote a code fence.
 */
function jsonCandidates(result: string): string[] {
  const candidates: string[] = [];
  const trimmed = result.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}"))
    candidates.push(trimmed);
  const fenced: string[] = [];
  for (const match of result.matchAll(FENCED_JSON_OPENER)) {
    const openIndex = match.index + match[0].length;
    if (result[openIndex] !== "{") continue;
    const object = balancedObjectAt(result, openIndex);
    if (object) fenced.push(object);
  }
  candidates.push(...fenced.reverse());
  let end = -1;
  for (
    let openIndex = result.lastIndexOf("{");
    openIndex !== -1;
    // lastIndexOf clamps a negative fromIndex to 0, which would revisit 0.
    openIndex = openIndex === 0 ? -1 : result.lastIndexOf("{", openIndex - 1)
  ) {
    const object = balancedObjectAt(result, openIndex);
    if (object === null) continue;
    const objectEnd = openIndex + object.length;
    // An object ending before the current one is an earlier sibling, not
    // part of the trailing verdict.
    if (objectEnd < end) continue;
    candidates.push(object);
    end = objectEnd;
  }
  return [...new Set(candidates)];
}

/**
 * Reads one judge session's stdout. Feedback carries schema codes and paths
 * only: other validation messages can echo rejected model values, which are
 * untrusted content derived from the pull request.
 */
export function parseRiskJudgeOutput(
  stdout: string,
  scores: RiskJudgePlan["judge"]["scores"],
): JudgeParse {
  let summary: z.infer<typeof execSummarySchema>;
  try {
    summary = execSummarySchema.parse(JSON.parse(stdout));
  } catch {
    return {
      invalidReason: "exec_error",
      retryFeedback: ["<root>: the session produced no result"],
    };
  }
  const sessionId = summary.session_id;
  if (summary.is_error)
    return {
      sessionId,
      invalidReason: "exec_error",
      retryFeedback: ["<root>: the session ended in an error"],
    };
  const shape = verdictShape(scores);
  let issues: { path: string; code: string }[] | undefined;
  for (const candidate of jsonCandidates(summary.result)) {
    let payload: unknown;
    try {
      payload = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = shape.safeParse(payload);
    if (result.success) {
      if (Buffer.byteLength(candidate) > MAX_VERDICT_BYTES) {
        issues ??= [{ path: "<root>", code: "too_big" }];
        continue;
      }
      return { sessionId, verdict: result.data };
    }
    issues ??= result.error.issues.map((issue) => ({
      path: issue.path.length === 0 ? "<root>" : issue.path.join("."),
      code: issue.code,
    }));
  }
  if (!issues)
    return {
      sessionId,
      invalidReason: "no_json",
      retryFeedback: ["<root>: return exactly one JSON object"],
    };
  return {
    sessionId,
    invalidReason: "schema",
    invalidPaths: [...new Set(issues.map((issue) => issue.path))],
    invalidCodes: [...new Set(issues.map((issue) => issue.code))],
    retryFeedback: issues.map((issue) => `${issue.path}: ${issue.code}`),
  };
}

/**
 * The whole environment of a judge session. Nothing is inherited: the job's
 * tokens, the review phase's settings and whatever a review session left in
 * the runner's home stay out. The session gets a home of its own, the
 * Factory credential, and a GitHub token that can only read.
 */
export function riskJudgeEnvironment(options: {
  evidence: RiskEvidenceWorkspace;
  path: string;
  factoryApiKey: string;
  factoryApiBaseUrl?: string;
  githubToken: string;
  repo: string;
  group: string;
}): Record<string, string> {
  const { homeDir, tmpDir } = options.evidence;
  return {
    PATH: options.path,
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    XDG_CACHE_HOME: join(homeDir, ".cache"),
    XDG_DATA_HOME: join(homeDir, ".local", "share"),
    TMPDIR: tmpDir,
    FACTORY_API_KEY: options.factoryApiKey,
    ...(options.factoryApiBaseUrl
      ? { FACTORY_API_BASE_URL: options.factoryApiBaseUrl }
      : {}),
    FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
    GH_TOKEN: options.githubToken,
    GH_REPO: options.repo,
    // Labels the session's telemetry with the experiment group.
    DROID_EXEC_RUN_TYPE: options.group,
  };
}

/** Runs one `droid exec` session and returns its stdout. */
export async function executeRiskDroid(
  cliPath: string,
  invocation: RiskDroidInvocation,
): Promise<string> {
  try {
    return (
      await execFileAsync(cliPath, [...invocation.args], {
        cwd: invocation.cwd,
        env: invocation.env,
        timeout: invocation.timeoutMs,
        maxBuffer: MAX_DROID_OUTPUT_BYTES,
      })
    ).stdout;
  } catch (error) {
    const failure = error as {
      stdout?: unknown;
      killed?: unknown;
      code?: unknown;
      signal?: unknown;
    };
    // A non-zero exit still carries the JSON failure summary on stdout,
    // which is the attempt record.
    if (
      typeof failure.stdout === "string" &&
      failure.stdout.trim().startsWith("{")
    )
      return failure.stdout;
    // `killed` is set only when the timeout sent the signal; the exit
    // shape after that varies.
    if (failure.killed === true)
      throw new RiskJudgeTimeoutError(Math.round(invocation.timeoutMs / 1000));
    // The underlying message quotes the command line and stderr.
    throw new Error(
      `The risk judge session could not run (exit ${String(failure.code ?? "unknown")}, signal ${String(failure.signal ?? "none")})`,
    );
  }
}

/**
 * Runs the plan's judge against the evidence workspace. The skill is the
 * whole prompt (`/pr-risk-judge`), its tools the whole tool surface, and
 * its settings the whole model configuration; head files and the diff are
 * data under `evidence/`, never ambient configuration. An answer that
 * misses the shape earns one strict retry naming the failed rules. Returns
 * every attempt, and the verdict when one had the shape.
 */
export async function runRiskJudge(options: {
  judge: RiskJudgePlan["judge"];
  snapshot: RiskSnapshot;
  evidence: RiskEvidenceWorkspace;
  env: Record<string, string>;
  execute: (invocation: RiskDroidInvocation) => Promise<string>;
}): Promise<{
  verdict?: Record<string, unknown>;
  attempts: RiskJudgeAttempt[];
}> {
  const { judge, evidence } = options;
  const skill = renderRiskSkill(judge.skill, options.snapshot, evidence);
  const settingsPath = join(evidence.rootDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify(judge.settings));
  const skillDir = join(
    evidence.rootDir,
    ".factory",
    "skills",
    RISK_JUDGE_SKILL_NAME,
  );
  await mkdir(skillDir, { recursive: true });
  const args = [
    "--settings",
    settingsPath,
    "exec",
    // Exec ends the session on any command above its autonomy level, so the
    // level has to cover what a verification does (installs, builds, test
    // runs). High still refuses destructive commands.
    "--auto",
    "high",
    "--disable-builtin-skills",
    "--tag",
    SESSION_TAG,
    "--only-tools",
    judge.enabledTools.join(","),
    "--output-format",
    "json",
    "--cwd",
    evidence.rootDir,
    `/${RISK_JUDGE_SKILL_NAME}`,
  ];
  const attempts: RiskJudgeAttempt[] = [];
  const attempt = async (skillText: string): Promise<JudgeParse> => {
    await writeFile(join(skillDir, "SKILL.md"), skillText);
    const startedAt = Date.now();
    const parsed = parseRiskJudgeOutput(
      await options.execute({
        args,
        cwd: evidence.rootDir,
        env: options.env,
        timeoutMs: judge.timeoutSeconds * 1000,
      }),
      judge.scores,
    );
    attempts.push({
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      valid: parsed.verdict !== undefined,
      durationMs: Date.now() - startedAt,
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
  if (first.verdict) return { verdict: first.verdict, attempts };
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
      judge.contract,
      "",
      "Do not invent evidence or change a judgment to satisfy the contract; restate the same verdict in the required shape.",
      "",
    ].join("\n"),
  );
  return { ...(retry.verdict ? { verdict: retry.verdict } : {}), attempts };
}
