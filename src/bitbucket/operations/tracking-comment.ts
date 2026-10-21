/**
 * Sticky tracking comment for Bitbucket pull requests.
 *
 * Bitbucket Cloud and Data Center both escape raw HTML in comments, so the
 * GitLab note's `<!-- -->` marker, `<details>` and `<sub>` would show up as
 * literal text. The marker here is a Markdown link reference definition,
 * which both renderers parse and never display.
 */

import {
  formatCostUsd,
  formatDurationMs,
} from "../../core/review/tracking/format";
import type {
  ReviewTrackingFields,
  ReviewTrackingState,
} from "../../core/review/tracking/types";

export const BITBUCKET_TRACKING_MARKER = "[//]: # (droid-tracking-comment)";

const STATE_HEADER: Record<ReviewTrackingState, string> = {
  running: "**Droid is reviewing this pull request...** ⏳",
  success: "**Droid finished reviewing this pull request** ✅",
  failure: "**Droid encountered an error reviewing this pull request** ❌",
};

export const TRUNCATED_DIFF_NOTICE =
  "Note: Bitbucket truncated this pull request's diff, so the review covered only part of the changes.";

export function buildTrackingCommentBody(
  options: ReviewTrackingFields & { diffTruncated?: boolean },
): string {
  const lines: string[] = [BITBUCKET_TRACKING_MARKER, ""];
  lines.push(STATE_HEADER[options.state]);
  lines.push("");

  if (options.securityReviewRan) lines.push("Security review: enabled");
  if (options.triggerUsername) {
    lines.push(`Triggered by ${options.triggerUsername}.`);
  }
  if (options.pipelineUrl) lines.push(`Build: ${options.pipelineUrl}`);
  if (options.jobUrl && options.jobUrl !== options.pipelineUrl) {
    lines.push(`Job log: ${options.jobUrl}`);
  }
  if (options.diffTruncated) {
    lines.push("");
    lines.push(TRUNCATED_DIFF_NOTICE);
  }

  const review = options.review;
  if (review) {
    const summary = review.summaryBody?.trim();
    if (summary) {
      lines.push("");
      lines.push(summary);
    }
    const counts: string[] = [];
    if (typeof review.posted === "number") {
      counts.push(
        `${review.posted} inline ${review.posted === 1 ? "comment" : "comments"} posted`,
      );
    }
    if (
      typeof review.fallbackPosted === "number" &&
      review.fallbackPosted > 0
    ) {
      counts.push(
        `${review.fallbackPosted} posted as ${
          review.fallbackPosted === 1 ? "a regular comment" : "regular comments"
        } (line outside the diff)`,
      );
    }
    if (typeof review.failed === "number" && review.failed > 0) {
      counts.push(`${review.failed} could not be posted`);
    }
    if (typeof review.skipped === "number" && review.skipped > 0) {
      counts.push(`${review.skipped} skipped`);
    }
    if (counts.length > 0) {
      lines.push("");
      lines.push(counts.join(" · "));
    }
  }

  if (options.state === "failure" && options.errorDetails) {
    lines.push("");
    lines.push("**Error details**");
    lines.push("");
    lines.push("```");
    lines.push(options.errorDetails.trim());
    lines.push("```");
  }

  const t = options.telemetry;
  if (t) {
    const bits: string[] = [];
    if (typeof t.totalNumTurns === "number")
      bits.push(`${t.totalNumTurns} turns`);
    if (typeof t.totalDurationMs === "number") {
      bits.push(formatDurationMs(t.totalDurationMs));
    }
    if (typeof t.totalCostUsd === "number" && t.totalCostUsd > 0) {
      bits.push(formatCostUsd(t.totalCostUsd));
    }
    if (bits.length > 0) {
      lines.push("");
      lines.push(`_${bits.join(" · ")}_`);
    }
    const sessions: string[] = [];
    if (t.pass1SessionId) sessions.push(`pass 1 \`${t.pass1SessionId}\``);
    if (t.pass2SessionId) sessions.push(`pass 2 \`${t.pass2SessionId}\``);
    if (sessions.length > 0) {
      lines.push("");
      lines.push(`Droid sessions: ${sessions.join(", ")}`);
    }
  }

  return lines.join("\n").trim() + "\n";
}

/** Top-level comments only: a reply quoting the marker is not the tracker. */
export function isTrackingComment(c: {
  body: string;
  parentId: number | null;
}): boolean {
  return (
    c.parentId === null &&
    c.body.split("\n").some((line) => line.trim() === BITBUCKET_TRACKING_MARKER)
  );
}

export function isOwnComment(
  c: { authorId: string | null },
  userId: string | null,
): boolean {
  return (
    userId !== null &&
    c.authorId !== null &&
    c.authorId.toLowerCase() === userId.toLowerCase()
  );
}

/**
 * The tracking comment these credentials wrote, if any. The marker alone
 * proves nothing (anyone can paste it), so the author must match too; with
 * an unknown identity nothing is reused.
 */
export function findOwnTrackingComment<
  T extends { body: string; parentId: number | null; authorId: string | null },
>(comments: T[], userId: string | null): T | undefined {
  return comments.find((c) => isTrackingComment(c) && isOwnComment(c, userId));
}
