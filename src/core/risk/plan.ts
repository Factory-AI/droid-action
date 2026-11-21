import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { StepError } from "../worker/step";
import {
  CommitShaSchema,
  RISK_RUNNER,
  RISK_SETTLE_MAX_BODY_BYTES,
  RiskPlanSchema,
  RiskResultFileSchema,
  RiskReviewOutcomeSchema,
  type RiskPlan,
  type RiskResultFile,
  type RiskReviewConfig,
  type RiskReviewOutcome,
  type RiskRun,
  type RiskSettleRequest,
} from "./types";

const PullRequestRefSchema = z.object({
  number: z.number().int().positive(),
  head: z.object({ sha: z.string() }).optional(),
  draft: z.boolean().optional(),
});

const EventSchema = z.object({
  pull_request: PullRequestRefSchema.optional(),
  workflow_run: z
    .object({
      head_sha: z.string().optional(),
      pull_requests: z.array(PullRequestRefSchema).optional(),
    })
    .optional(),
  inputs: z.record(z.unknown()).nullish(),
});

export function parseFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

/** The review conclusion to report, or undefined for anything unrecognized. */
export function parseReviewOutcome(
  value: string | undefined,
): RiskReviewOutcome | undefined {
  const parsed = RiskReviewOutcomeSchema.safeParse(value?.trim());
  return parsed.success ? parsed.data : undefined;
}

/**
 * What the review's prepare step read of `.factory/review.yaml`, or
 * undefined unless it said both where and what: a run with half of it has
 * nothing to tell Factory.
 */
export function parseReviewConfig(
  baseSha: string | undefined,
  hasRules: string | undefined,
): RiskReviewConfig | undefined {
  const sha = CommitShaSchema.safeParse(baseSha?.trim());
  const flag = hasRules?.trim();
  if (!sha.success || (flag !== "true" && flag !== "false")) return undefined;
  return { baseSha: sha.data, hasRules: flag === "true" };
}

function workDir(env: NodeJS.ProcessEnv): string {
  const temp = env.RUNNER_TEMP?.trim();
  if (!temp) {
    throw new StepError("runner_temp_missing", "RUNNER_TEMP is not set");
  }
  return join(temp, "pr-risk");
}

export function riskPlanPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RISK_PLAN_PATH?.trim() || join(workDir(env), "plan.json");
}

export function riskResultPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RISK_RESULT_PATH?.trim() || join(workDir(env), "result.json");
}

// Parse failures are reported without Zod's message, which can quote values
// from a file that holds the served judge.
export async function readRiskPlan(path: string): Promise<RiskPlan> {
  try {
    return RiskPlanSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new StepError(
      "plan_unreadable",
      "The PR risk plan from the begin step could not be read",
    );
  }
}

/**
 * Reads what the assess step left. A missing file means that step never got
 * to write one, which is still worth settling: Factory then marks the head
 * as unavailable instead of leaving a stale answer on it.
 */
export async function readRiskResult(path: string): Promise<RiskResultFile> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { result: { status: "failed", reason: "runner_died" } };
  }
  try {
    return RiskResultFileSchema.parse(JSON.parse(raw));
  } catch {
    return { result: { status: "failed", reason: "result_unreadable" } };
  }
}

export async function readEvent(path: string | undefined): Promise<unknown> {
  if (!path) return {};
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * The pull request this run is about, the head its event named, and whether
 * the event saw a draft. An explicit number wins; what the event saw is only
 * reported when the event is about that same pull request. Queued runs start
 * in any order, so the draft flag is the event's, not the live state: Factory
 * needs it to tell a late draft run from the run for a ready pull request.
 */
export function resolveTarget(
  prNumberInput: string | undefined,
  event: unknown,
): { pr: number; eventHeadSha?: string; eventDraft?: true } | undefined {
  const parsed = EventSchema.safeParse(event);
  const payload = parsed.success ? parsed.data : {};
  const candidates = [
    ...(payload.pull_request ? [payload.pull_request] : []),
    ...(payload.workflow_run?.pull_requests ?? []).map((pullRequest) => ({
      number: pullRequest.number,
      head:
        pullRequest.head ??
        (payload.workflow_run?.head_sha
          ? { sha: payload.workflow_run.head_sha }
          : undefined),
    })),
  ];

  const explicit =
    prNumberInput?.trim() || String(payload.inputs?.pr_number ?? "");
  let match = candidates[0];
  let pr = match?.number;
  if (explicit) {
    if (!/^[1-9][0-9]*$/.test(explicit)) {
      throw new StepError(
        "invalid_pr_number",
        "pr_number must be a positive integer",
      );
    }
    pr = Number(explicit);
    match = candidates.find((candidate) => candidate.number === pr);
  }
  if (pr === undefined) return undefined;
  const sha = match?.head?.sha;
  return {
    pr,
    ...(sha && CommitShaSchema.safeParse(sha).success
      ? { eventHeadSha: sha }
      : {}),
    ...(match && "draft" in match && match.draft === true
      ? { eventDraft: true }
      : {}),
  };
}

/** What this run can attest to about itself. */
export function buildRiskRun(
  dryRun: boolean,
  env: NodeJS.ProcessEnv = process.env,
): RiskRun {
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  return {
    runner: RISK_RUNNER,
    ...(env.GITHUB_EVENT_NAME ? { trigger: env.GITHUB_EVENT_NAME } : {}),
    ...(env.GITHUB_RUN_ID ? { runId: env.GITHUB_RUN_ID } : {}),
    ...(Number.isInteger(runAttempt) && runAttempt > 0 ? { runAttempt } : {}),
    dryRun,
  };
}

/**
 * The settle request for a plan and what the assess step left. A result too
 * large for Factory to read is settled as a failure rather than dropped.
 */
export function buildSettleRequest(
  plan: RiskPlan,
  file: RiskResultFile,
): RiskSettleRequest {
  const request: RiskSettleRequest = {
    repo: plan.repo,
    pr: plan.pr,
    headSha: plan.headSha,
    run: {
      ...plan.run,
      ...(file.droidCliVersion
        ? { droidCliVersion: file.droidCliVersion }
        : {}),
    },
    result: file.result,
    ...(file.shadow ? { shadow: file.shadow } : {}),
  };
  const fits = (candidate: RiskSettleRequest) =>
    Buffer.byteLength(JSON.stringify(candidate)) <= RISK_SETTLE_MAX_BODY_BYTES;
  if (fits(request)) return request;
  // The shadow re-check is only measured, so it gives way to the verdict,
  // and its failure marker too when even that does not fit beside it.
  const { shadow: _shadow, ...primary } = request;
  if (file.shadow) {
    const marked: RiskSettleRequest = {
      ...primary,
      shadow: { status: "failed", reason: "result_too_large" },
    };
    if (fits(marked)) return marked;
  }
  if (fits(primary)) return primary;
  return {
    ...primary,
    result: { status: "failed", reason: "result_too_large" },
  };
}
