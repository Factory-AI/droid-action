import * as fs from "fs/promises";
import type {
  ReviewPostFailure,
  ReviewPostOutcome,
  ReviewPostResults,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(root: Record<string, unknown>, field: string): number {
  const value = root[field];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`review post results has invalid \`${field}\``);
  }
  return value as number;
}

export function parseReviewPostResults(raw: string): ReviewPostResults {
  const root = asRecord(JSON.parse(raw));
  if (!root) throw new Error("review post results is not an object");

  if (
    root.summaryBody !== null &&
    root.summaryBody !== undefined &&
    typeof root.summaryBody !== "string"
  ) {
    throw new Error("review post results has invalid `summaryBody`");
  }
  if (!Array.isArray(root.failures)) {
    throw new Error("review post results has invalid `failures`");
  }

  const failures: ReviewPostFailure[] = root.failures.map((value, index) => {
    const failure = asRecord(value);
    if (
      !failure ||
      typeof failure.path !== "string" ||
      (failure.line !== null &&
        (!Number.isInteger(failure.line) || (failure.line as number) <= 0)) ||
      typeof failure.error !== "string"
    ) {
      throw new Error(
        `review post results has invalid failure at index ${index}`,
      );
    }
    return {
      path: failure.path,
      line: failure.line as number | null,
      error: failure.error,
    };
  });

  return {
    posted: count(root, "posted"),
    fallbackPosted: count(root, "fallbackPosted"),
    approved: count(root, "approved"),
    rejected: count(root, "rejected"),
    failed: count(root, "failed"),
    skipped: count(root, "skipped"),
    summaryBody: typeof root.summaryBody === "string" ? root.summaryBody : null,
    failures,
  };
}

export function reviewPostOutcome(
  results: ReviewPostResults,
): ReviewPostOutcome {
  return {
    posted: results.posted,
    fallbackPosted: results.fallbackPosted,
    failed: results.failed,
    skipped: results.skipped,
    summaryBody: results.summaryBody,
  };
}

/**
 * Reads results when present. A missing file means posting did not run;
 * malformed output remains an error rather than masquerading as absence.
 */
export async function readReviewPostOutcome(
  filePath: string,
): Promise<ReviewPostOutcome | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return reviewPostOutcome(parseReviewPostResults(raw));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}
