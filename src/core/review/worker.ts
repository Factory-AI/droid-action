import { join } from "node:path";
import { z } from "zod";
import { redactCredentials } from "../../utils/redact-credentials";
import {
  EVIDENCE_SECONDS,
  SESSION_STOP_SECONDS,
  endingsSchema,
  pathName,
  sessionSchema,
  type WorkerBounds,
} from "../worker/run";
import { StepError } from "../worker/step";
import type { ReviewPromptSettings } from "./prompts/types";
import type { ReviewFinding } from "./validated/types";

/**
 * How long both passes of a review may take together. A first number: no
 * review of a large pull request has been timed through the worker yet.
 */
export const REVIEW_SECONDS = 3600;
const MAX_REPORTED_ISSUES = 10;

/** How long `droid-review review` may run before it is asked to stop. */
export function reviewWorkerBounds(): WorkerBounds {
  const stopAfterMs =
    (REVIEW_SECONDS + SESSION_STOP_SECONDS + EVIDENCE_SECONDS) * 1000;
  return {
    stopAfterMs,
    killAfterMs: stopAfterMs + SESSION_STOP_SECONDS * 1000,
  };
}

function promptsDir(env: NodeJS.ProcessEnv): string {
  return join(env.RUNNER_TEMP || "/tmp", "droid-prompts");
}

/** Where prepare leaves the review's input for the step that runs it. */
export function reviewInputPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(promptsDir(env), "review_input.json");
}

/** Where the worker's report is kept for the job's debug artifacts. */
export function reviewReportPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(promptsDir(env), "review_report.json");
}

/** Where a review's answer is left for the step that publishes it. */
export function validatedReviewPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.REVIEW_VALIDATED_PATH || join(promptsDir(env), "review_validated.json")
  );
}

/** A finding still open, under the names the worker reads its anchor by. */
type PriorFinding = ReviewFinding & { old_path?: string };

/** What `droid-review review` reads, less the judge it is run with. */
export type ReviewWorkerInput = {
  repo: string;
  prNumber: number;
  platform: "github";
  runId?: string;
  runAttempt?: string;
  base: string;
  head: string;
  baseRef: string;
  headRef: string;
  title: string;
  body: string;
  comments: string;
  fork: boolean;
  suggestions: boolean;
  security: boolean;
  focus?: string;
  settings: ReviewPromptSettings;
  prior?: {
    findings: PriorFinding[];
    reviewed?: { head: string; incremental: boolean };
  };
  model?: string;
  reasoningEffort?: string;
  seconds: number;
};

/**
 * The input of one review: what only GitHub and the workflow know. Text a
 * pass is shown passes through the job's credential redaction here, because
 * this process holds the GitHub tokens and the worker's never does.
 */
export function buildReviewInput(options: {
  owner: string;
  repo: string;
  prNumber: number;
  runId?: string;
  runAttempt?: string;
  base: string;
  head: string;
  pullRequest: {
    baseRefName: string;
    headRefName: string;
    isFork: boolean;
    title: string;
    body: string;
  };
  comments: { issueComments: unknown[]; reviewComments: unknown[] };
  /** The head the last review was of, when there was one. */
  reviewedHead?: string;
  /** Whether that head is a commit the checkout now holds. */
  reviewedHeadFetched: boolean;
  /** Whether the plan is to review only the change since that head. */
  incremental: boolean;
  /** Every finding the last review's state holds. */
  findings: ReviewFinding[];
  securityOnly: boolean;
  /** The focus a person asked for, on a manual review. */
  focus?: string;
  settings: ReviewPromptSettings;
  env?: NodeJS.ProcessEnv;
}): ReviewWorkerInput {
  const env = options.env ?? process.env;
  const { pullRequest, reviewedHead } = options;
  const reviewModel = env.REVIEW_MODEL?.trim();
  // A security-only review has one model for both passes.
  const model = options.securityOnly
    ? env.SECURITY_MODEL?.trim() || reviewModel
    : reviewModel;
  const reasoningEffort = env.REASONING_EFFORT?.trim();
  const focus = options.focus?.trim();
  // The last one stored under an ID is the one the publisher tracks.
  const open = new Map(
    options.findings
      .filter(({ state }) => state !== "resolved" && state !== "dismissed")
      .map((finding) => [
        finding.id,
        // The stored finding names a renamed file's old path `oldPath`.
        finding.oldPath ? { ...finding, old_path: finding.oldPath } : finding,
      ]),
  );
  return {
    repo: `${options.owner}/${options.repo}`,
    prNumber: options.prNumber,
    platform: "github",
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.runAttempt ? { runAttempt: options.runAttempt } : {}),
    base: options.base,
    head: options.head,
    baseRef: pullRequest.baseRefName,
    headRef: pullRequest.headRefName,
    title: redactCredentials(pullRequest.title),
    body: redactCredentials(pullRequest.body),
    comments: redactCredentials(JSON.stringify(options.comments, null, 2)),
    fork: pullRequest.isFork,
    suggestions: env.INCLUDE_SUGGESTIONS !== "false",
    // Set only by a combined review. A security-only review is the judge's.
    security: env.SECURITY_REVIEW_ENABLED === "true",
    ...(focus ? { focus: redactCredentials(focus) } : {}),
    settings: options.settings,
    ...(reviewedHead
      ? {
          prior: {
            findings: [...open.values()],
            // Without the commit the worker reviews the whole change, still
            // shown the open findings, and none can be marked fixed.
            ...(options.reviewedHeadFetched
              ? {
                  reviewed: {
                    head: reviewedHead,
                    incremental: options.incremental,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    seconds: REVIEW_SECONDS,
  };
}

const SessionSchema = sessionSchema({
  id: z.string().min(1),
  model: z.string(),
  reasoningEffort: z.string().optional(),
});

/**
 * The part of a `droid-review review` report this action reads. The answer
 * is the judge's and is published as it stands: nothing here reads a field
 * of it.
 */
export const ReviewReportSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("unpinned"),
    problem: z.union([
      z.object({ kind: z.literal("unresolved"), ref: z.string() }),
      z.object({ kind: z.enum(["shallow", "unrelated", "ambiguous"]) }),
    ]),
  }),
  ...endingsSchema(
    {
      revision: z.object({ base: z.string(), head: z.string() }),
      sessions: z.array(SessionSchema),
    },
    z.record(z.unknown()),
  ),
]);
type ReviewReport = z.infer<typeof ReviewReportSchema>;

/** How a review ended, as the steps after it are told. */
export type ReviewOutcome = {
  /** The report's status, or that the worker left none. */
  status: ReviewReport["status"] | "no_report";
  /** The model and effort the first session reported, when one started. */
  model?: string;
  reasoningEffort?: string;
} & ({ answer: Record<string, unknown> } | { error: string });

/**
 * What a report means for the run. Only an answer about the prepared commits
 * is published. Every other ending is a failure whose sentence is built from
 * the report's own labels, never from anything a model wrote.
 */
export function reviewOutcome(
  report: ReviewReport,
  prepared: { base: string; head: string },
): ReviewOutcome {
  if (report.status === "unpinned") {
    const { problem } = report;
    const why =
      problem.kind === "unresolved"
        ? `unresolved: ${problem.ref}`
        : problem.kind;
    return {
      status: report.status,
      error: `The pull request's commits could not be pinned (\`${why}\`).`,
    };
  }
  const { revision, sessions } = report;
  if (revision.head !== prepared.head || revision.base !== prepared.base) {
    throw new StepError(
      "worker_report_unreadable",
      "The review worker's report is not about the prepared commits",
    );
  }
  const first = sessions.find((session) => "id" in session);
  const started = {
    status: report.status,
    ...(first ? { model: first.model } : {}),
    ...(first?.reasoningEffort
      ? { reasoningEffort: first.reasoningEffort }
      : {}),
  };
  // The validator is the second session, and the last one's ending is the
  // report's.
  const pass = sessions.length > 1 ? "validator" : "candidates";
  switch (report.status) {
    case "answered":
      return { ...started, answer: report.answer };
    case "failed":
      return {
        ...started,
        error: `The ${pass} pass could not run (\`${report.problem}\`).`,
      };
    case "interrupted":
      return {
        ...started,
        error: `The ${pass} pass was stopped (\`${report.by}\`).`,
      };
    case "invalid": {
      const last = sessions.at(-1);
      const issues = (last?.status === "invalid" ? last.issues : [])
        .slice(0, MAX_REPORTED_ISSUES)
        .map(({ path, code }) => `${pathName(path)}: ${code}`)
        .join(", ");
      return {
        ...started,
        error: `The ${pass} pass's answer broke its contract: ${issues}.`,
      };
    }
  }
}

/**
 * The note for a review that ran on another model than the workflow named.
 * Droid replaces a model when the session starts and reports the one that
 * ran, so the two names are all there is to go on. A tier alias always
 * resolves to another name, and is not noted.
 */
export function modelFallbackNote(options: {
  asked?: string;
  ran?: string;
  securityOnly: boolean;
}): string | undefined {
  const { asked, ran } = options;
  if (!asked || !ran || asked === ran) return undefined;
  if (/^[a-z0-9]+-latest-(premium|balanced|fast)$/.test(asked)) {
    return undefined;
  }
  const flow = options.securityOnly ? "security review" : "code review";
  const input = options.securityOnly
    ? "`security_model` or `review_model`"
    : "`review_model`";
  return (
    `The ${flow} ran on \`${ran}\`, not the \`${asked}\` the workflow asked ` +
    `for. Droid replaces a model your organization's model policy does not ` +
    `allow, or one that has been retired, when a session starts. Remove the ` +
    `${input} input to use the recommended default, or set it to a model or ` +
    `tier alias your organization allows.`
  );
}
