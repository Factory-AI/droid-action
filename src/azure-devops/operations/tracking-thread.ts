/**
 * Sticky tracking thread for Azure DevOps pull requests.
 *
 * One general (file-less) PR thread whose first comment is edited through
 * the run. It is found again on re-runs by the `Factory.DroidTracking`
 * thread property, with the hidden marker in the body as a fallback for
 * threads whose properties were stripped. It is created without a status
 * so it never counts against the "Check for comment resolution" policy.
 *
 * Neither tag proves anything: anyone who can comment can paste the marker
 * or set the property through the REST API. A thread is only adopted when
 * its first comment was written by the identity this token acts as, and
 * when that identity is unknown a new thread is created instead.
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

type TrackingRef = { threadId: number; commentId: number };

/** The thread's first live comment when `ownerId` wrote it and it is tagged. */
export function ownTrackingComment(
  thread: AdoThread | null | undefined,
  ownerId: string | null,
): TrackingRef | null {
  if (!thread || thread.isDeleted || !ownerId) return null;
  const first = (thread.comments ?? []).find((c) => !c.isDeleted);
  if (!first) return null;
  if (first.author?.id?.toLowerCase() !== ownerId.toLowerCase()) return null;
  const tagged =
    thread.properties?.[DROID_TRACKING_PROPERTY] !== undefined ||
    (first.content ?? "").includes(DROID_TRACKING_MARKER);
  return tagged ? { threadId: thread.id, commentId: first.id } : null;
}

export function findTrackingThread(
  threads: AdoThread[],
  ownerId: string | null,
): TrackingRef | null {
  for (const thread of threads) {
    const own = ownTrackingComment(thread, ownerId);
    if (own) return own;
  }
  return null;
}

/** The identity this token posts as, or null (callers then never adopt a thread). */
export async function resolveTrackingOwner(
  client: AzureDevopsClient,
): Promise<string | null> {
  try {
    const id = await client.getAuthenticatedUserId();
    if (id) return id;
    console.warn(
      "Azure DevOps did not report the authenticated identity; a new tracking thread will be created.",
    );
  } catch (error) {
    console.warn(
      "Could not resolve the authenticated Azure DevOps identity; a new tracking thread will be created:",
      error instanceof Error ? error.message : String(error),
    );
  }
  return null;
}

/**
 * The tracking thread to edit at the end of the run: the one named in the
 * state file (which the review passes can rewrite) only if it checks out,
 * else any thread this identity owns on the PR.
 */
export async function resolveOwnTrackingThread(opts: {
  client: AzureDevopsClient;
  pullRequestId: number;
  ownerId: string | null;
  hint: { threadId: unknown; commentId: unknown };
}): Promise<TrackingRef | null> {
  const { client, pullRequestId, ownerId, hint } = opts;
  if (!ownerId) return null;
  if (Number.isInteger(hint.threadId) && (hint.threadId as number) > 0) {
    try {
      const own = ownTrackingComment(
        await client.getThread(pullRequestId, hint.threadId as number),
        ownerId,
      );
      if (own) return own;
      console.warn(
        `Thread ${hint.threadId} is not a Droid tracking thread written by this identity; not editing it.`,
      );
    } catch (error) {
      console.warn(
        `Could not load thread ${hint.threadId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return findTrackingThread(await client.listThreads(pullRequestId), ownerId);
}

export function trackingThreadRequest(body: string): AdoCreateThreadRequest {
  return {
    comments: [{ parentCommentId: 0, content: body, commentType: "text" }],
    properties: {
      [DROID_TRACKING_PROPERTY]: { $type: "System.String", $value: "1" },
    },
  };
}

export async function createTrackingThread(
  client: AzureDevopsClient,
  pullRequestId: number,
  body: string,
): Promise<TrackingRef> {
  const thread = await client.createThread(
    pullRequestId,
    trackingThreadRequest(body),
  );
  const commentId = thread.comments?.[0]?.id;
  if (typeof thread.id !== "number" || typeof commentId !== "number") {
    throw new Error(
      "Azure DevOps returned a thread without an id or first comment",
    );
  }
  return { threadId: thread.id, commentId };
}

/** Updates this identity's tracking thread, or creates one. */
export async function upsertTrackingThread(opts: {
  client: AzureDevopsClient;
  pullRequestId: number;
  threads: AdoThread[];
  ownerId: string | null;
  body: string;
}): Promise<{ threadId: number; commentId: number; created: boolean }> {
  const existing = findTrackingThread(opts.threads, opts.ownerId);
  if (existing) {
    await opts.client.updateComment(
      opts.pullRequestId,
      existing.threadId,
      existing.commentId,
      opts.body,
    );
    return { ...existing, created: false };
  }
  const created = await createTrackingThread(
    opts.client,
    opts.pullRequestId,
    opts.body,
  );
  return { ...created, created: true };
}
