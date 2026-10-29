import type { ReviewFinding, ReviewSummaryData } from "../validated/types";
import type { RenderOptions, ReviewRenderInput } from "./types";

/** Conservative UTF-8 budgets, below GitHub's 65,536-character limit. */
export const MAX_REVIEW_OUTPUT_BYTES = 60 * 1024;
export const MAX_INLINE_OUTPUT_BYTES = 30 * 1024;
const NOTICE =
  "> [!NOTE]\n> Some optional review context was shortened to fit the output limit. Finding identities, counts, locations, and thread state are preserved.";
const SUGGESTION_NOTICE =
  "The suggested replacement was omitted because it exceeds the output limit. No partial suggestion was posted; verify and apply the complete fix in the source.";

export class ReviewOutputBudgetError extends Error {
  constructor() {
    super(
      "The review's essential finding identities and state exceed the output limit. Split the change into smaller reviews; no truncated state was published.",
    );
    this.name = "ReviewOutputBudgetError";
  }
}
export function outputBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Only prose is truncated. Never apply this to replacement code or identities. */
export function truncateReviewText(value: string, bytes: number): string {
  if (outputBytes(value) <= bytes) return value;
  if (bytes <= 0) return "";
  return `${Buffer.from(value)
    .subarray(0, bytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "")}… [shortened]`;
}
function compactFinding(
  finding: ReviewFinding,
  quota: number,
  suggestionLimit: number,
): ReviewFinding {
  const oversizedSuggestion =
    finding.suggestion !== undefined &&
    outputBytes(finding.suggestion) > suggestionLimit;
  return {
    ...finding,
    body: [
      truncateReviewText(finding.body, quota),
      oversizedSuggestion ? SUGGESTION_NOTICE : "",
    ]
      .filter(Boolean)
      .join(" "),
    why: truncateReviewText(finding.why, quota),
    verification: truncateReviewText(finding.verification, quota),
    agent_prompt: truncateReviewText(finding.agent_prompt, quota),
    also_at: finding.also_at.slice(0, 5),
    ...(oversizedSuggestion ? { suggestion: undefined } : {}),
  };
}
function compactSummary(
  summary: ReviewSummaryData | undefined,
  quota: number,
  limit: number,
): ReviewSummaryData | undefined {
  if (!summary) return undefined;
  return {
    ...summary,
    ...(summary.body
      ? { body: truncateReviewText(summary.body, quota * 2) }
      : {}),
    ...(summary.whatChanged
      ? { whatChanged: truncateReviewText(summary.whatChanged, quota * 2) }
      : {}),
    ...(summary.risk
      ? {
          risk: {
            ...summary.risk,
            reason: truncateReviewText(summary.risk.reason, quota),
          },
        }
      : {}),
    diagram: undefined,
    changes: summary.changes?.slice(0, limit).map((change) => ({
      ...change,
      area: truncateReviewText(change.area, 100),
      files: change.files.slice(0, 5),
      summary: truncateReviewText(change.summary, quota),
    })),
    filesSkipped: summary.filesSkipped?.slice(0, limit).map((file) => ({
      ...file,
      reason: truncateReviewText(file.reason, 100),
    })),
    filesSkippedCount:
      summary.filesSkippedCount ?? summary.filesSkipped?.length,
    guidelines: summary.guidelines?.slice(0, limit),
    suggestedReviewers: summary.suggestedReviewers?.slice(0, limit),
    preMergeChecks: summary.preMergeChecks?.slice(0, limit).map((check) => ({
      ...check,
      reason: check.reason
        ? truncateReviewText(check.reason, quota)
        : undefined,
    })),
  };
}
function compactInput(
  input: ReviewRenderInput,
  stage: number,
): ReviewRenderInput {
  const count =
    (input.findings?.length ?? 0) + (input.reviewState?.findings.length ?? 0);
  const quota = Math.min(
    stage === 1 ? 1500 : stage === 2 ? 400 : 100,
    Math.max(0, Math.floor(10000 / Math.max(1, count))),
  );
  const limit = stage === 1 ? 20 : stage === 2 ? 10 : 3;
  const suggestionLimit = stage === 1 ? 16 * 1024 : stage === 2 ? 4 * 1024 : 0;
  return {
    ...input,
    findings: input.findings?.map((finding) =>
      compactFinding(finding, quota, suggestionLimit),
    ),
    resolved: input.resolved?.map((finding) => compactFinding(finding, 0, 0)),
    summary: compactSummary(input.summary, quota, limit),
    droppedCount: input.droppedCount ?? input.dropped?.length,
    dropped: input.dropped?.slice(0, limit).map((finding) => ({
      ...finding,
      reason: truncateReviewText(finding.reason, quota),
      title: finding.title ? truncateReviewText(finding.title, 100) : undefined,
    })),
    includeAgentPrompts: stage === 3 ? false : input.includeAgentPrompts,
    previousBody:
      input.previousBody &&
      stage < 3 &&
      outputBytes(input.previousBody) < 20 * 1024
        ? input.previousBody
        : undefined,
    error: input.error ? truncateReviewText(input.error, quota * 2) : undefined,
    skipReason: input.skipReason
      ? truncateReviewText(input.skipReason, quota)
      : undefined,
    reviewState: input.reviewState
      ? {
          ...input.reviewState,
          reviewed: input.reviewState.reviewed?.slice(-20),
          findings: input.reviewState.findings.map((finding) => ({
            ...finding,
            title: finding.title
              ? truncateReviewText(finding.title, 140)
              : undefined,
            body: finding.body
              ? truncateReviewText(finding.body, quota)
              : undefined,
            finding: finding.finding
              ? {
                  ...compactFinding(
                    finding.finding,
                    stage === 3 ? 0 : Math.min(quota, 300),
                    0,
                  ),
                  title: truncateReviewText(finding.finding.title, 140),
                  why: "",
                  verification: "",
                  agent_prompt: "",
                  also_at: [],
                  suggestion: undefined,
                  body: truncateReviewText(
                    finding.finding.body,
                    stage === 3 ? 0 : Math.min(quota, 300),
                  ),
                }
              : undefined,
          })),
        }
      : undefined,
  };
}
/** Re-render compact structured data, never slice already-rendered Markdown/JSON. */
export function fitReviewOutput(
  input: ReviewRenderInput,
  render: (input: ReviewRenderInput) => string,
  budget = MAX_REVIEW_OUTPUT_BYTES,
  compactionNotice = NOTICE,
): string {
  const initial = render(input);
  if (outputBytes(initial) <= budget) return initial;
  for (const stage of [1, 2, 3]) {
    const result = `${render(compactInput(input, stage))}${compactionNotice ? `\n\n${compactionNotice}` : ""}`;
    if (outputBytes(result) <= budget) return result;
  }
  throw new ReviewOutputBudgetError();
}
export function fitInlineOutput(
  finding: ReviewFinding,
  options: RenderOptions,
  render: (finding: ReviewFinding, options: RenderOptions) => string,
): string {
  const initial = render(finding, options);
  if (outputBytes(initial) <= MAX_INLINE_OUTPUT_BYTES) return initial;
  for (const quota of [2000, 500, 100]) {
    const compact = compactFinding(finding, quota, 8 * 1024);
    const result = `${render(compact, options)}\n\n${NOTICE}`;
    if (outputBytes(result) <= MAX_INLINE_OUTPUT_BYTES) return result;
  }
  throw new ReviewOutputBudgetError();
}
