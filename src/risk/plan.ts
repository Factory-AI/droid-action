import { z } from "zod";
import {
  postRiskApi,
  RISK_PLAN_ENDPOINT,
  type RiskApi,
  type RiskRunIdentity,
} from "./api";

/** Covers a cold backend reading the pull request and its review threads. */
const PLAN_TIMEOUT_MS = 60_000;

const PLAN_TRIGGERS = [
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
] as const;

export type RiskPlanTarget = {
  repo: string;
  pr: number;
  trigger: (typeof PLAN_TRIGGERS)[number] | "manual";
  eventHeadSha?: string;
};

const commitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const assignmentSchema = z.object({
  experiment: z.string().min(1),
  group: z.string().min(1),
  ruleId: z.string().min(1),
  judgeConfig: z.string().min(1),
});

const skipSchema = z.object({
  action: z.literal("skip"),
  reason: z.string().catch("unknown"),
  headSha: z.string().optional(),
});
const holdSchema = z.object({
  action: z.literal("hold"),
  reason: z.string().catch("unknown"),
  headSha: z.string().optional(),
  unresolvedThreads: z.number().optional(),
});
const judgeSchema = z.object({
  action: z.literal("judge"),
  headSha: commitSha,
  baseSha: commitSha,
  assignment: assignmentSchema,
  judge: z.object({
    skill: z.string().min(1),
    skillSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    // Joined into one `--only-tools` value, so a name cannot hold a comma
    // or read as a flag.
    enabledTools: z.array(z.string().regex(/^[^\s,-][^\s,]*$/u)).nonempty(),
    settings: z.record(z.unknown()),
    timeoutSeconds: z.number().int().positive(),
    scores: z.record(
      z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/u),
      z.tuple([z.number().int(), z.number().int()]),
    ),
    contract: z.string().min(1),
  }),
  priorDeclines: z.array(
    z.object({ headSha: z.string(), concerns: z.string() }),
  ),
});

export type RiskJudgePlan = z.infer<typeof judgeSchema>;
export type RiskPlan =
  | z.infer<typeof skipSchema>
  | z.infer<typeof holdSchema>
  | RiskJudgePlan
  | { action: "unknown"; reportedAction?: string };

/**
 * Which pull request this run would assess, read from the event the runner
 * reported. Anything that is not a same-repository pull request event or an
 * explicit dispatch naming a pull request is not assessed, and the backend
 * is not asked.
 */
export function resolveRiskPlanTarget(
  env: Record<string, string | undefined>,
): { target: RiskPlanTarget } | { skip: string } {
  const repo = env.GITHUB_REPOSITORY?.trim();
  if (!repo) return { skip: "no_repository" };
  const number = (value: string | undefined) => {
    const parsed = Number(value?.trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    const pr = number(env.RISK_PR_NUMBER);
    return pr
      ? { target: { repo, pr, trigger: "manual" } }
      : { skip: "no_pull_request" };
  }
  if (env.GITHUB_EVENT_NAME !== "pull_request")
    return { skip: "event_not_assessed" };
  const trigger = PLAN_TRIGGERS.find(
    (candidate) => candidate === env.RISK_EVENT_ACTION,
  );
  const pr = number(env.RISK_EVENT_PR_NUMBER);
  if (!trigger || !pr) return { skip: "event_not_assessed" };
  // A fork's run has no Factory credential and no App token to judge with.
  if (env.RISK_EVENT_HEAD_REPO !== repo) return { skip: "fork" };
  const eventHeadSha = commitSha.safeParse(env.RISK_EVENT_HEAD_SHA);
  return {
    target: {
      repo,
      pr,
      trigger,
      ...(eventHeadSha.success ? { eventHeadSha: eventHeadSha.data } : {}),
    },
  };
}

/**
 * Reads a plan answer. An action this client does not know, or a known one
 * in a shape it cannot use, reads as `unknown`, which never assesses:
 * judging on a plan that was not understood would run a judge the backend
 * never chose.
 */
export function parseRiskPlan(input: unknown): RiskPlan {
  const reported = z.object({ action: z.string() }).safeParse(input);
  if (!reported.success) return { action: "unknown" };
  for (const schema of [skipSchema, holdSchema, judgeSchema]) {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
  }
  return { action: "unknown", reportedAction: reported.data.action };
}

/** Asks the backend what to do with one pull request head. */
export async function requestRiskPlan(
  target: RiskPlanTarget,
  run: RiskRunIdentity,
  api: RiskApi,
): Promise<RiskPlan> {
  return parseRiskPlan(
    await postRiskApi(
      api,
      RISK_PLAN_ENDPOINT,
      { ...target, run },
      PLAN_TIMEOUT_MS,
    ),
  );
}
