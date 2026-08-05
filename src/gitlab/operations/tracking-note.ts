/**
 * Sticky tracking note helpers for GitLab MR pipelines.
 *
 * The tracking note carries a hidden HTML marker so we can find and
 * update the same note across retries instead of creating duplicates.
 *
 * The state machine (running/success/failure), telemetry shape, and
 * formatting helpers are platform-agnostic and live in
 * `src/core/review/tracking/`. This file owns the GitLab-specific body
 * rendering, including the markdown layout, the security badge, the
 * error-details accordion, and the hidden marker conventions.
 */

import {
  formatCostUsd,
  formatDurationMs,
} from "../../core/review/tracking/format";
import type {
  ReviewTrackingFields,
  ReviewTrackingState,
} from "../../core/review/tracking/types";

export const DROID_TRACKING_MARKER = "<!-- droid-tracking-note -->";
export const DROID_SECURITY_BADGE_MARKER = "<!-- droid-security-badge -->";

export type TrackingNoteState = ReviewTrackingState;
export type TrackingNoteTelemetry = NonNullable<
  ReviewTrackingFields["telemetry"]
>;
export type TrackingNoteOptions = ReviewTrackingFields;

export const SECURITY_BADGE =
  "![security](https://img.shields.io/badge/security%20review-enabled-blue?style=flat-square&logo=shield) ";

const STATE_HEADER: Record<TrackingNoteState, string> = {
  running:
    "**Droid is reviewing this merge request...** :hourglass_flowing_sand:",
  success: "**Droid finished reviewing this merge request** :white_check_mark:",
  failure: "**Droid encountered an error reviewing this MR** :x:",
};

export function buildTrackingNoteBody(options: TrackingNoteOptions): string {
  const lines: string[] = [];

  if (options.securityReviewRan) {
    lines.push(`${DROID_SECURITY_BADGE_MARKER}${SECURITY_BADGE}`);
  }

  lines.push(DROID_TRACKING_MARKER);
  lines.push("");
  lines.push(STATE_HEADER[options.state]);
  lines.push("");

  if (options.triggerUsername) {
    lines.push(`Triggered by @${options.triggerUsername}.`);
  }

  if (options.pipelineUrl) {
    lines.push(`Pipeline: ${options.pipelineUrl}`);
  }
  if (options.jobUrl) {
    lines.push(`Job log: ${options.jobUrl}`);
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
    if (typeof review.failed === "number" && review.failed > 0) {
      counts.push(`${review.failed} could not be anchored to the diff`);
    }
    if (typeof review.skipped === "number" && review.skipped > 0) {
      counts.push(`${review.skipped} skipped`);
    }
    if (counts.length > 0) {
      lines.push("");
      lines.push(counts.join(" • "));
    }
  }

  if (options.state === "failure" && options.errorDetails) {
    lines.push("");
    lines.push("<details><summary>Error details</summary>");
    lines.push("");
    lines.push("```");
    lines.push(options.errorDetails.trim());
    lines.push("```");
    lines.push("</details>");
  }

  if (options.telemetry) {
    const t = options.telemetry;
    const bits: string[] = [];
    if (typeof t.totalNumTurns === "number")
      bits.push(`${t.totalNumTurns} turns`);
    if (typeof t.totalDurationMs === "number")
      bits.push(formatDurationMs(t.totalDurationMs));
    if (typeof t.totalCostUsd === "number" && t.totalCostUsd > 0)
      bits.push(formatCostUsd(t.totalCostUsd));
    if (bits.length > 0) {
      lines.push("");
      lines.push(`<sub>${bits.join(" • ")}</sub>`);
    }
    if (t.pass1SessionId || t.pass2SessionId) {
      lines.push("");
      lines.push("<details><summary>Droid session IDs</summary>");
      lines.push("");
      if (t.pass1SessionId) lines.push(`- Pass 1: \`${t.pass1SessionId}\``);
      if (t.pass2SessionId) lines.push(`- Pass 2: \`${t.pass2SessionId}\``);
      lines.push("</details>");
    }
  }

  return lines.join("\n").trim() + "\n";
}

export function findExistingTrackingNote<
  T extends { id: number; body: string },
>(notes: T[]): T | undefined {
  return notes.find((n) => n.body && n.body.includes(DROID_TRACKING_MARKER));
}
