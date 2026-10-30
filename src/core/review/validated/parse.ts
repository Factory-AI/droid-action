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
import { normalizeFinding, normalizeSummary } from "./finding";
import type { DroppedFinding, ReviewFinding, ReviewSummaryData } from "./types";
export type {
  ReviewFinding,
  ReviewSeverity,
  ReviewSummaryData,
  DroppedFinding,
  FindingLocation,
} from "./types";

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
  finding?: ReviewFinding;
};

export type ParsedValidatedReview = {
  approved: ValidatedReviewComment[];
  approvedCount: number;
  rejectedCount: number;
  skipped: Array<{ index: number; path: string | null; reason: string }>;
  summaryBody: string | null;
  /**
   * The head commit the validator reviewed against, taken from `meta.headSha`
   * and the approved comments' `commit_id`. Null when the file names no
   * single SHA; the poster then omits `commit_id` rather than guess one.
   */
  commitId: string | null;
  /** Conflicting declarations are not the same as absent legacy provenance. */
  conflictingCommitIds: boolean;
  findings: ReviewFinding[];
  outsideDiff: ReviewFinding[];
  dropped: DroppedFinding[];
  summary: ReviewSummaryData;
  fixedFindings: Array<{ id: string; evidence: string }>;
  fixedFindingIds: string[];
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

const GIT_SHA = /^[0-9a-f]{7,64}$/i;

/** A model-written SHA is only trusted when it looks like one. */
function asCommitSha(value: unknown): string | null {
  return typeof value === "string" && GIT_SHA.test(value.trim())
    ? value.trim()
    : null;
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
  const findings: ReviewFinding[] = [];
  const outsideDiff: ReviewFinding[] = [];
  const dropped: DroppedFinding[] = [];
  const fixedFindings: ParsedValidatedReview["fixedFindings"] = [];
  const skipped: ParsedValidatedReview["skipped"] = [];
  let approvedCount = 0;
  let rejectedCount = 0;

  const meta = asRecord(root.meta);
  const shas = new Set<string>();
  const metaSha = meta ? asCommitSha(meta.headSha) : null;
  if (metaSha) shas.add(metaSha.toLowerCase());

  results.forEach((entry, index) => {
    const skip = (reason: string, p: string | null = null): void => {
      skipped.push({ index, path: p, reason });
    };

    const record = asRecord(entry);
    if (!record) return skip("entry is not an object");

    if (record.status === "fixed") {
      const candidate = asRecord(record.candidate) ?? asRecord(record.comment);
      const id =
        asNonEmptyString(record.id) ??
        (candidate ? asNonEmptyString(candidate.id) : null);
      const evidence =
        asNonEmptyString(record.evidence) ?? asNonEmptyString(record.reason);
      if (id && evidence) fixedFindings.push({ id, evidence });
      else skip("fixed entry requires a finding id and verification evidence");
      return;
    }
    if (record.status !== "approved") {
      // Anything not explicitly approved never reaches the PR/MR; an unknown
      // status counts the same as rejected.
      rejectedCount += 1;
      const candidate = asRecord(record.candidate) ?? asRecord(record.comment);
      dropped.push({
        index,
        path: candidate ? asNonEmptyString(candidate.path) : null,
        ...(candidate && asNonEmptyString(candidate.title)
          ? { title: asNonEmptyString(candidate.title)! }
          : {}),
        reason: asNonEmptyString(record.reason) ?? "Not approved by validation",
      });
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
    if (
      comment.severity !== undefined &&
      !["P0", "P1", "P2"].includes(String(comment.severity))
    ) {
      return skip("approved comment has an invalid `severity`", filePath);
    }
    const side = comment.side === "LEFT" ? "LEFT" : "RIGHT";
    const line = asPositiveInt(comment.line);
    const oldLine = asPositiveInt(comment.old_line);
    const anchor = side === "LEFT" ? (oldLine ?? line) : line;
    const rich =
      comment.title !== undefined ||
      comment.severity !== undefined ||
      comment.outside_diff === true;
    if (anchor === null && !rich) {
      return skip(`no usable line anchor (side=${side})`, filePath);
    }

    const startLine = asPositiveInt(comment.startLine);
    const commentSha = asCommitSha(comment.commit_id);
    if (commentSha) shas.add(commentSha.toLowerCase());
    const finding = normalizeFinding(comment);
    findings.push(finding);
    if (finding.outside_diff) {
      outsideDiff.push(finding);
      return;
    }

    approved.push({
      path: filePath,
      body,
      line,
      startLine:
        startLine !== null && anchor !== null && startLine < anchor
          ? startLine
          : null,
      side,
      old_path: asNonEmptyString(comment.old_path),
      old_line: oldLine,
      ...(rich ? { finding } : {}),
    });
  });

  const summary = asRecord(root.reviewSummary);
  if (Array.isArray(root.findingResolutions)) {
    for (const rawResolution of root.findingResolutions) {
      const resolution = asRecord(rawResolution);
      if (!resolution || resolution.status !== "fixed") continue;
      const id = asNonEmptyString(resolution.id);
      const evidence = asNonEmptyString(resolution.evidence);
      if (id && evidence && !fixedFindings.some((f) => f.id === id))
        fixedFindings.push({ id, evidence });
    }
  }

  // Disagreeing SHAs mean the model anchored comments against more than one
  // commit; pinning to any of them would misplace the others.
  const commitId = shas.size === 1 ? [...shas][0]! : null;

  return {
    approved,
    approvedCount,
    rejectedCount,
    skipped,
    summaryBody: summary ? asNonEmptyString(summary.body) : null,
    commitId,
    conflictingCommitIds: shas.size > 1,
    findings,
    outsideDiff,
    dropped,
    summary: normalizeSummary(root.reviewSummary),
    fixedFindings,
    fixedFindingIds: fixedFindings.map((finding) => finding.id),
  };
}
