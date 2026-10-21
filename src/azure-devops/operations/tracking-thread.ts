/**
 * Sticky tracking thread for Azure DevOps pull requests.
 *
 * One general (file-less) PR thread whose first comment is edited through
 * the run. It is found again on re-runs by the `Factory.DroidTracking`
 * thread property, with the hidden marker in the body as a fallback for
 * threads whose properties were stripped. It is created without a status
 * so it never counts against the "Check for comment resolution" policy.
 */

import {
  formatCostUsd,
  formatDurationMs,
} from "../../core/review/tracking/format";
import type { ReviewTrackingFields } from "../../core/review/tracking/types";
import type { AzureDevopsClient } from "../api/client";
import type { AdoCreateThreadRequest, AdoThread } from "../types";

export const DROID_TRACKING_MARKER = "<!-- droid-tracking-note -->";
export const DROID_TRACKING_PROPERTY = "Factory.DroidTracking";

export const SECURITY_BADGE =
  "![security](https://img.shields.io/badge/security%20review-enabled-blue?style=flat-square&logo=shield)";

const STATE_HEADER: Record<ReviewTrackingFields["state"], string> = {
  running: "**Droid is reviewing this pull request...** :hourglass:",
  success: "**Droid finished reviewing this pull request** :white_check_mark:",
  failure: "**Droid encountered an error reviewing this pull request** :x:",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function buildTrackingCommentBody(
  options: ReviewTrackingFields,
): string {
  const lines: string[] = [DROID_TRACKING_MARKER];
  if (options.securityReviewRan) lines.push(SECURITY_BADGE);
  lines.push("", STATE_HEADER[options.state], "");

  if (options.triggerUsername) {
    lines.push(`Triggered by ${options.triggerUsername}.`);
  }
  if (options.pipelineUrl) lines.push(`Build: ${options.pipelineUrl}`);
  if (options.jobUrl) lines.push(`Job log: ${options.jobUrl}`);

  const review = options.review;
  if (review) {
    const summary = review.summaryBody?.trim();
    if (summary) lines.push("", summary);

    const counts: string[] = [];
    if (typeof review.posted === "number") {
      counts.push(
        `${plural(review.posted, "inline comment", "inline comments")} posted`,
      );
    }
    if (review.fallbackPosted) {
      counts.push(
        `${plural(review.fallbackPosted, "posted as a general comment", "posted as general comments")} (line outside the diff)`,
      );
    }
    if (review.failed) {
      counts.push(
        `${review.failed} could not be posted (inline + general comment fallback failed)`,
      );
    }
    if (review.skipped) counts.push(`${review.skipped} skipped`);
    if (counts.length > 0) lines.push("", counts.join(" • "));
  }

  if (options.state === "failure" && options.errorDetails) {
    lines.push(
      "",
      "<details><summary>Error details</summary>",
      "",
      "```",
      options.errorDetails.trim(),
      "```",
      "</details>",
    );
  }

  const t = options.telemetry;
  if (t) {
    const bits: string[] = [];
    if (typeof t.totalNumTurns === "number")
      bits.push(`${t.totalNumTurns} turns`);
    if (typeof t.totalDurationMs === "number")
      bits.push(formatDurationMs(t.totalDurationMs));
    if (typeof t.totalCostUsd === "number" && t.totalCostUsd > 0)
      bits.push(formatCostUsd(t.totalCostUsd));
    if (bits.length > 0) lines.push("", `<sub>${bits.join(" • ")}</sub>`);
    if (t.pass1SessionId || t.pass2SessionId) {
      lines.push("", "<details><summary>Droid session IDs</summary>", "");
      if (t.pass1SessionId) lines.push(`- Pass 1: \`${t.pass1SessionId}\``);
      if (t.pass2SessionId) lines.push(`- Pass 2: \`${t.pass2SessionId}\``);
      lines.push("</details>");
    }
  }

  return lines.join("\n").trim() + "\n";
}

export function findTrackingThread(
  threads: AdoThread[],
): { threadId: number; commentId: number } | null {
  for (const thread of threads) {
    if (thread.isDeleted) continue;
    const first = (thread.comments ?? []).find((c) => !c.isDeleted);
    if (!first) continue;
    const tagged =
      thread.properties?.[DROID_TRACKING_PROPERTY] !== undefined ||
      (first.content ?? "").includes(DROID_TRACKING_MARKER);
    if (tagged) return { threadId: thread.id, commentId: first.id };
  }
  return null;
}

export function trackingThreadRequest(body: string): AdoCreateThreadRequest {
  return {
    comments: [{ parentCommentId: 0, content: body, commentType: "text" }],
    properties: {
      [DROID_TRACKING_PROPERTY]: { $type: "System.String", $value: "1" },
    },
  };
}

/** Updates the existing tracking thread, or creates one. */
export async function upsertTrackingThread(opts: {
  client: AzureDevopsClient;
  pullRequestId: number;
  threads: AdoThread[];
  body: string;
}): Promise<{ threadId: number; commentId: number; created: boolean }> {
  const existing = findTrackingThread(opts.threads);
  if (existing) {
    await opts.client.updateComment(
      opts.pullRequestId,
      existing.threadId,
      existing.commentId,
      opts.body,
    );
    return { ...existing, created: false };
  }
  const thread = await opts.client.createThread(
    opts.pullRequestId,
    trackingThreadRequest(opts.body),
  );
  const commentId = thread.comments?.[0]?.id;
  if (typeof thread.id !== "number" || typeof commentId !== "number") {
    throw new Error(
      "Azure DevOps returned a thread without an id or first comment",
    );
  }
  return { threadId: thread.id, commentId, created: true };
}
