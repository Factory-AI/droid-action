/**
 * Parser for the `review_validated.json` that Pass 2 writes.
 *
 * This is the trust boundary between the model and the platform API on
 * every platform that posts from CI: the file comes from a model, so only
 * entries explicitly marked `"approved"` with a usable line anchor make it
 * through, and everything else is counted but never posted. Both
 * `src/entrypoints/gitlab-post-review.ts` and
 * `src/entrypoints/github-post-review.ts` consume the parsed shape.
 */

export type ValidatedReviewComment = {
  path: string;
  body: string;
  /** New-file line (RIGHT) or, for LEFT comments without `old_line`, the old-file line. */
  line: number | null;
  /** Start of a multi-line anchor; null when the comment is single-line. */
  startLine: number | null;
  side: "LEFT" | "RIGHT";
  old_path: string | null;
  old_line: number | null;
};

export type ParsedValidatedReview = {
  approved: ValidatedReviewComment[];
  approvedCount: number;
  rejectedCount: number;
  skipped: Array<{ index: number; path: string | null; reason: string }>;
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
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The line a comment anchors to, on whichever side applies. */
export function validatedAnchorLine(
  comment: ValidatedReviewComment,
): number | null {
  return comment.side === "LEFT"
    ? (comment.old_line ?? comment.line)
    : comment.line;
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

  const approved: ValidatedReviewComment[] = [];
  const skipped: ParsedValidatedReview["skipped"] = [];
  let approvedCount = 0;
  let rejectedCount = 0;

  results.forEach((entry, index) => {
    const skip = (reason: string, p: string | null = null): void => {
      skipped.push({ index, path: p, reason });
    };

    const record = asRecord(entry);
    if (!record) return skip("entry is not an object");

    if (record.status !== "approved") {
      // Anything not explicitly approved never reaches the PR/MR; an unknown
      // status counts the same as rejected.
      rejectedCount += 1;
      return;
    }
    approvedCount += 1;

    const comment = asRecord(record.comment);
    if (!comment) return skip("approved entry has no `comment` object");

    const filePath = asNonEmptyString(comment.path);
    const body = asNonEmptyString(comment.body);
    if (!filePath || !body) {
      return skip("approved comment is missing `path` or `body`", filePath);
    }

    if (
      comment.side !== undefined &&
      comment.side !== null &&
      comment.side !== "LEFT" &&
      comment.side !== "RIGHT"
    ) {
      return skip("approved comment has an invalid `side`", filePath);
    }
    const side = comment.side === "LEFT" ? "LEFT" : "RIGHT";
    const line = asPositiveInt(comment.line);
    const oldLine = asPositiveInt(comment.old_line);
    const anchor = side === "LEFT" ? (oldLine ?? line) : line;
    if (anchor === null) {
      return skip(`no usable line anchor (side=${side})`, filePath);
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

  return {
    approved,
    approvedCount,
    rejectedCount,
    skipped,
    summaryBody: summary ? asNonEmptyString(summary.body) : null,
  };
}
