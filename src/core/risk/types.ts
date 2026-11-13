import { z } from "zod";

export const RISK_RUNNER = "droid-action";
export const RISK_DEFAULT_API_BASE_URL = "https://app.factory.ai";
export const RISK_BEGIN_PATH = "/api/internal/pr-risk/begin";
export const RISK_SETTLE_PATH = "/api/internal/pr-risk/settle";
export const RISK_OIDC_AUDIENCE = "factory-pr-risk";
export const RISK_OIDC_HEADER = "x-github-oidc-token";
export const RISK_WORKFLOW_NOT_TRUSTED = "workflow_not_trusted";
export const RISK_JUDGE_SKILL_NAME = "pr-risk-judge";
export const RISK_SNAPSHOT_PLACEHOLDER = "{{PR_SNAPSHOT_JSON}}";
export const RISK_SESSION_TAG = "riskAssessment";
export const RISK_SETTLE_MAX_BODY_BYTES = 256 * 1024;

const FAILURE_REASON = /^[a-z][a-z0-9_]{0,63}$/;

/** The part of `fetch` these modules use, so a test can stand in for it. */
export type RiskFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A failure with the short machine label a failed run is settled under. */
export class RiskError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RiskError";
    this.reason = reason;
  }
}

/** The label a failure is reported under; anything unlabelled is `unexpected`. */
export function failureReason(error: unknown): string {
  return error instanceof RiskError && FAILURE_REASON.test(error.reason)
    ? error.reason
    : "unexpected";
}

const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const RiskRunSchema = z.object({
  runner: z.string().min(1),
  trigger: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  runAttempt: z.number().int().positive().optional(),
  droidCliVersion: z.string().min(1).optional(),
  dryRun: z.boolean(),
});
export type RiskRun = z.infer<typeof RiskRunSchema>;

export const RiskReviewOutcomeSchema = z.enum([
  "success",
  "failure",
  "cancelled",
  "skipped",
]);
export type RiskReviewOutcome = z.infer<typeof RiskReviewOutcomeSchema>;

export type RiskBeginRequest = {
  repo: string;
  pr: number;
  eventHeadSha?: string;
  /** Set when the triggering event saw the pull request as a draft. */
  eventDraft?: boolean;
  manual: boolean;
  reviewOutcome?: RiskReviewOutcome;
  run: RiskRun;
};

/**
 * The judge as Factory serves it. `settings` is written to the session's
 * settings file untouched, and `sha256` goes back with the verdict so Factory
 * can tell which judge answered.
 */
export const RiskJudgeSchema = z.object({
  group: z.string().min(1),
  skill: z.string().min(1),
  enabledTools: z.array(z.string().min(1)).nonempty(),
  settings: z.record(z.unknown()),
  scores: z.record(z.tuple([z.number().int(), z.number().int()])),
  timeoutSeconds: z.number().int().positive(),
  sha256: Sha256Schema,
});
export type RiskJudge = z.infer<typeof RiskJudgeSchema>;
export type RiskScoreRanges = RiskJudge["scores"];

const RiskPullRequestSchema = z.object({
  title: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changedFiles: z.number().int().nonnegative(),
});

const RiskPriorDeclineSchema = z.object({
  headSha: z.string().min(1),
  concerns: z.string(),
});
export type RiskPriorDecline = z.infer<typeof RiskPriorDeclineSchema>;

const RiskJudgeAssignmentSchema = z.object({
  headSha: CommitShaSchema,
  baseSha: CommitShaSchema,
  pullRequest: RiskPullRequestSchema,
  priorDeclines: z.array(RiskPriorDeclineSchema),
  judge: RiskJudgeSchema,
});

// Reasons stay open strings and unknown keys are dropped, so Factory can add
// either without breaking a pinned action.
export const RiskBeginResponseSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("skip"), reason: z.string() }),
  z.object({
    action: z.literal("hold"),
    reason: z.string(),
    headSha: CommitShaSchema,
  }),
  RiskJudgeAssignmentSchema.extend({ action: z.literal("judge") }),
]);
export type RiskBeginResponse = z.infer<typeof RiskBeginResponseSchema>;

/** Everything the assess and settle steps need from the begin step. */
export const RiskPlanSchema = RiskJudgeAssignmentSchema.extend({
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  run: RiskRunSchema,
});
export type RiskPlan = z.infer<typeof RiskPlanSchema>;

export const RiskJudgeAttemptSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    valid: z.boolean(),
    durationMs: z.number().int().nonnegative().optional(),
    invalidReason: z.enum(["exec_error", "no_json", "schema"]).optional(),
    invalidPaths: z.array(z.string()).optional(),
    invalidCodes: z.array(z.string()).optional(),
    retryFeedback: z.array(z.string()).optional(),
  })
  .strict();
export type RiskJudgeAttempt = z.infer<typeof RiskJudgeAttemptSchema>;

export const RiskSettleResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("judged"),
    baseSha: CommitShaSchema,
    judgeSha256: Sha256Schema,
    snapshotHash: z.string().min(1),
    listedFiles: z.number().int().nonnegative(),
    attempts: z.array(RiskJudgeAttemptSchema).nonempty(),
    durationMs: z.number().int().nonnegative(),
    verdict: z.record(z.unknown()),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.string().regex(FAILURE_REASON),
    judgeSha256: Sha256Schema.optional(),
    attempts: z.array(RiskJudgeAttemptSchema).optional(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
]);
export type RiskSettleResult = z.infer<typeof RiskSettleResultSchema>;

/** What the assess step leaves for the settle step. */
export const RiskResultFileSchema = z.object({
  headSha: z.string().optional(),
  droidCliVersion: z.string().min(1).optional(),
  result: RiskSettleResultSchema,
});
export type RiskResultFile = z.infer<typeof RiskResultFileSchema>;

export type RiskSettleRequest = {
  repo: string;
  pr: number;
  headSha: string;
  run: RiskRun;
  result: RiskSettleResult;
};

export const RiskSettleResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("stale_head"), headSha: z.string() }),
  z.object({
    status: z.literal("published"),
    outcome: z.string(),
    reason: z.string().optional(),
    publication: z
      .object({
        comment: z.object({ action: z.string() }).optional(),
        approval: z.object({ action: z.string() }).optional(),
      })
      .optional(),
  }),
]);
export type RiskSettleResponse = z.infer<typeof RiskSettleResponseSchema>;

export type PullRequestRiskFileStatus =
  | "added"
  | "removed"
  | "modified"
  | "renamed"
  | "copied"
  | "changed"
  | "unchanged";

export type PullRequestRiskFileKind =
  | "runtime"
  | "test"
  | "docs"
  | "generated_or_lock";

/** Pull request metadata a snapshot is built from. */
export type PullRequestRiskInput = {
  repo: string;
  prNumber: number;
  title: string;
  baseSha: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
};

/** One changed-file entry from GitHub's pull request files API. */
export type PullRequestRiskFile = {
  filename: string;
  previousFilename?: string;
  status: PullRequestRiskFileStatus;
  additions: number;
  deletions: number;
};

export type PullRequestRiskSnapshotFile = PullRequestRiskFile & {
  kind: PullRequestRiskFileKind;
};

/** The compact inventory of one pull request head that the judge is shown. */
export type PullRequestRiskSnapshot = {
  pullRequest: PullRequestRiskInput;
  /** Newest first; empty for a pull request's first assessment. */
  priorDeclines: readonly RiskPriorDecline[];
  summary: {
    runtimeFiles: number;
    testFiles: number;
    docsFiles: number;
    generatedOrLockFiles: number;
    runtimeLinesChanged: number;
    testLinesChanged: number;
    unlistedFiles: number;
    workspaces: readonly string[];
  };
  files: readonly PullRequestRiskSnapshotFile[];
};

/** On-disk evidence for one judge run. */
export type PrRiskEvidenceWorkspace = {
  rootDir: string;
  headTreeDir: string;
  diffPath: string;
  inventoryPath: string;
  /** The default branch's `.factory/pr-risk/guidelines.md`, or null when absent. */
  guidelinesPath: string | null;
  snapshotHash: string;
};
