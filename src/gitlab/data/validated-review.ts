/**
 * Parser for the `review_validated.json` file that Pass 2 writes.
 *
 * The file is produced by a model, so this is the trust boundary between
 * "the agent said so" and "we call the GitLab API with it". Only entries
 * explicitly marked `status: "approved"` are eligible to post, and every
 * one of them must carry a usable line anchor — anything else is reported
 * as skipped so the job log and the tracking note can account for it
 * instead of the finding vanishing.
 */

import type { ReviewCommentInput } from "../operations/post-review";

export type SkippedComment = {
  index: number;
  path: string | null;
  reason: string;
};

export type ParsedValidatedReview = {
  approved: ReviewCommentInput[];
  approvedCount: number;
  rejectedCount: number;
  skipped: SkippedComment[];
  summaryBody: string | null;
};

export class InvalidValidatedReviewError extends Error {
  constructor(message: string) {
    super(`Invalid validated review file: ${message}`);
    this.name = "InvalidValidatedReviewError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function parseValidatedReview(raw: string): ParsedValidatedReview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new InvalidValidatedReviewError(
      `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const root = asRecord(parsed);
  if (!root) {
    throw new InvalidValidatedReviewError("top level is not an object");
  }

  const results = root.results;
  if (!Array.isArray(results)) {
    throw new InvalidValidatedReviewError("missing `results` array");
  }

  const approved: ReviewCommentInput[] = [];
  const skipped: SkippedComment[] = [];
  let approvedCount = 0;
  let rejectedCount = 0;

  results.forEach((entry, index) => {
    const record = asRecord(entry);
    if (!record) {
      skipped.push({ index, path: null, reason: "entry is not an object" });
      return;
    }

    const status = typeof record.status === "string" ? record.status : "";
    if (status !== "approved") {
      // Anything not explicitly approved never reaches the MR. Rejected is
      // the expected case; an unknown status is counted the same way.
      rejectedCount += 1;
      return;
    }

    approvedCount += 1;

    const comment = asRecord(record.comment);
    if (!comment) {
      skipped.push({
        index,
        path: null,
        reason: "approved entry has no `comment` object",
      });
      return;
    }

    const filePath = asNonEmptyString(comment.path);
    const body = asNonEmptyString(comment.body);
    if (!filePath || !body) {
      skipped.push({
        index,
        path: filePath,
        reason: "approved comment is missing `path` or `body`",
      });
      return;
    }

    const side = comment.side === "LEFT" ? "LEFT" : "RIGHT";
    const line = asPositiveInt(comment.line);
    const oldLine = asPositiveInt(comment.old_line);
    const anchor = side === "LEFT" ? (oldLine ?? line) : line;
    if (anchor === null) {
      skipped.push({
        index,
        path: filePath,
        reason: `approved comment has no usable line anchor (side=${side})`,
      });
      return;
    }

    const startLine = asPositiveInt(comment.startLine);

    approved.push({
      path: filePath,
      body,
      line,
      startLine: startLine !== null && startLine < anchor ? startLine : null,
      side,
      old_path: asNonEmptyString(comment.old_path),
      old_line: oldLine,
    });
  });

  const summary = asRecord(root.reviewSummary);
  const summaryBody = summary ? asNonEmptyString(summary.body) : null;

  return {
    approved,
    approvedCount,
    rejectedCount,
    skipped,
    summaryBody,
  };
}
