import { z } from "zod";
import { FAILURE_REASON } from "../worker/step";

export const RISK_RUNNER = "droid-action";
export const RISK_DEFAULT_API_BASE_URL = "https://app.factory.ai";
export const RISK_BEGIN_PATH = "/api/internal/pr-risk/begin";
export const RISK_SETTLE_PATH = "/api/internal/pr-risk/settle";
export const RISK_OIDC_AUDIENCE = "factory-pr-risk";
export const RISK_OIDC_HEADER = "x-github-oidc-token";
export const RISK_WORKFLOW_NOT_TRUSTED = "workflow_not_trusted";
export const RISK_UNKNOWN_ACTION = "unknown_action";
export const RISK_SETTLE_MAX_BODY_BYTES = 256 * 1024;
/** What this version can do beyond a full judgment, sent with every begin. */
export const RISK_CAPABILITIES = ["incremental"];

/** The part of `fetch` these modules use, so a test can stand in for it. */
export type RiskFetch = (url: string, init: RequestInit) => Promise<Response>;

export const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const RISK_VERDICT_FIELD_MODES = ["required", "omitted"] as const;

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

/**
 * `.factory/review.yaml` as the review's prepare step read it: the pull
 * request's base commit, which it read the file at, and whether the file
 * has a `rules` key. A repository without the file has none.
 */
export type RiskReviewConfig = { baseSha: string; hasRules: boolean };

export type RiskBeginRequest = {
  repo: string;
  pr: number;
  eventHeadSha?: string;
  /** Set when the triggering event saw the pull request as a draft. */
  eventDraft?: boolean;
  manual: boolean;
  reviewOutcome?: RiskReviewOutcome;
  /**
   * Lets Factory read the rules at the commit the review was configured
   * at, and skip the read when the file has none. Absent when no review
   * ran in this job.
   */
  reviewConfig?: RiskReviewConfig;
  capabilities?: string[];
  run: RiskRun;
};

/**
 * The judge as Factory serves it. It is handed to the worker unchanged, and
 * `sha256` comes back with the verdict so Factory can tell which judge
 * answered. `verdictField` is sent only as `omitted`, for a judge decided by
 * risk level alone; absent, or a value this version does not know, it is
 * `required`, so an unknown mode can only fail a run, never let an answer
 * skip the verdict.
 */
const RiskJudgeSchema = z.object({
  group: z.string().min(1),
  skill: z.string().min(1),
  enabledTools: z.array(z.string().min(1)).nonempty(),
  settings: z.record(z.unknown()),
  scores: z.record(z.tuple([z.number().int(), z.number().int()])),
  timeoutSeconds: z.number().int().positive(),
  verdictField: z.enum(RISK_VERDICT_FIELD_MODES).optional().catch("required"),
  sha256: Sha256Schema,
});
export type RiskJudge = z.infer<typeof RiskJudgeSchema>;

/**
 * An earlier verdict on this pull request that Factory asks the judge to
 * re-check against what changed since. `enforce` judges the head that way
 * instead of afresh; `shadow` judges it afresh as usual and runs the
 * re-check alongside, reported separately and never published. It is handed
 * to the worker unchanged. The step itself reads only the two commits, which
 * it fetches.
 */
const RiskIncrementalSchema = z.object({
  mode: z.enum(["shadow", "enforce"]),
  reason: z.string(),
  priorHeadSha: CommitShaSchema,
  priorAssessmentId: z.string().min(1),
  priorBaseSha: CommitShaSchema,
  judgeSha256: Sha256Schema,
  prior: z.object({
    verdict: z.boolean(),
    outcome: z.string().min(1),
    brief: z.string(),
    details: z.string(),
    concerns: z
      .array(z.object({ id: z.string().min(1), text: z.string() }))
      .optional(),
  }),
});

const RiskJudgeAssignmentSchema = z.object({
  headSha: CommitShaSchema,
  baseSha: CommitShaSchema,
  pullRequest: z.object({ title: z.string() }),
  priorDeclines: z.array(
    z.object({ headSha: z.string().min(1), concerns: z.string() }),
  ),
  judge: RiskJudgeSchema,
  incremental: RiskIncrementalSchema.optional(),
});

// Reasons stay open strings and unknown keys are dropped, so Factory can add
// either without breaking a pinned action. An action added later is read as
// a skip, and a settle status added later as unknown, by the client.
export const RiskBeginResponseSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("skip"), reason: z.string() }),
  z.object({
    action: z.literal("hold"),
    reason: z.string(),
    headSha: z.string(),
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

/** One judge session. An answer that broke the contract names the rules it broke. */
const RiskJudgeAttemptSchema = z
  .object({
    sessionId: z.string().min(1),
    valid: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    invalidReason: z.literal("schema").optional(),
    invalidPaths: z.array(z.string()).optional(),
    invalidCodes: z.array(z.string()).optional(),
    retryFeedback: z.array(z.string()).optional(),
  })
  .strict();
export type RiskJudgeAttempt = z.infer<typeof RiskJudgeAttemptSchema>;

/**
 * One check a re-check cited, as the worker ran it again (`index` into the
 * verdict's `checks`). Only `ran` carries an exit code; a check the worker
 * did not run (`rejected`, `skipped`) or that did not finish (`timed_out`,
 * `failed_to_start`) proves nothing.
 */
const RiskCheckRunSchema = z.object({
  index: z.number().int().nonnegative(),
  outcome: z.enum([
    "ran",
    "timed_out",
    "failed_to_start",
    "rejected",
    "skipped",
  ]),
  exitCode: z.number().int().optional(),
  reason: z.string().regex(FAILURE_REASON).optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

/**
 * A judged head, under the names both the worker's report and Factory's
 * settle request give it.
 */
export const RiskAnswerSchema = z.object({
  judgeSha256: Sha256Schema,
  snapshotHash: z.string().min(1),
  // The blob of `.factory/pr-risk/guidelines.md` the evidence was built
  // from, null when the default branch has none. Factory keeps a carried
  // approval only while that blob is unchanged.
  guidelinesBlobSha: CommitShaSchema.nullable(),
  listedFiles: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  verdict: z.record(z.unknown()),
  // Present only when the plan asked this judgment for a re-check:
  // `incremental` when the judge saw the prior verdict and what changed
  // since, `full` when that evidence could not be built and the head was
  // judged afresh instead, for the reason `incrementalFallback` gives.
  mode: z.enum(["incremental", "full"]).optional(),
  incrementalFallback: z.string().regex(FAILURE_REASON).optional(),
  priorHeadSha: CommitShaSchema.optional(),
  priorAssessmentId: z.string().min(1).optional(),
  // An enforced re-check that approves: the only exit codes Factory accepts.
  checkRuns: z.array(RiskCheckRunSchema).optional(),
});

export const RiskSettleResultSchema = z.discriminatedUnion("status", [
  RiskAnswerSchema.extend({
    status: z.literal("judged"),
    baseSha: CommitShaSchema,
    attempts: z.array(RiskJudgeAttemptSchema).nonempty(),
  }),
  z.object({
    status: z.literal("failed"),
    reason: z.string().regex(FAILURE_REASON),
    attempts: z.array(RiskJudgeAttemptSchema).optional(),
    durationMs: z.number().int().nonnegative().optional(),
  }),
]);
export type RiskSettleResult = z.infer<typeof RiskSettleResultSchema>;

/** What the assess step leaves for the settle step. */
export const RiskResultFileSchema = z.object({
  droidCliVersion: z.string().min(1).optional(),
  result: RiskSettleResultSchema,
  /** The re-check run alongside a shadowed full judgment. */
  shadow: RiskSettleResultSchema.optional(),
});
export type RiskResultFile = z.infer<typeof RiskResultFileSchema>;

export type RiskSettleRequest = {
  repo: string;
  pr: number;
  headSha: string;
  run: RiskRun;
  result: RiskSettleResult;
  shadow?: RiskSettleResult;
};

export const RiskSettleResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("stale_head"), headSha: z.string() }),
  z.object({ status: z.literal("skipped"), reason: z.string() }),
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
export type RiskSettleResponse =
  | z.infer<typeof RiskSettleResponseSchema>
  | { status: "unknown" };
