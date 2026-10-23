/**
 * Turns approved findings from `review_validated.json` into Bitbucket
 * inline comments. The diff line index decides each anchor's line type
 * (added / removed / context), which Data Center requires and Cloud uses
 * to pick `to` vs `from`. Findings that cannot anchor fall back to a
 * regular pull request comment.
 */

import type { FileLineIndex } from "../../core/review/validated/diff";
import {
  validatedAnchorLine,
  type ValidatedReviewComment,
} from "../../core/review/validated/parse";
import type { BitbucketClient, BitbucketInlineAnchor } from "../types";

export type PostReviewResult = {
  posted: number;
  fallbackPosted: number;
  failures: Array<{ path: string; line: number | null; error: string }>;
};

/**
 * Map a validated comment onto the diff, or explain why it cannot anchor.
 * With no index (diff unavailable) the anchor is a best guess the API may
 * refuse, which then degrades to the regular-comment fallback.
 */
export function resolveInlineAnchor(
  comment: ValidatedReviewComment,
  index: Map<string, FileLineIndex> | null,
): { anchor: BitbucketInlineAnchor } | { reason: string } {
  const line = validatedAnchorLine(comment);
  if (line === null) return { reason: "no usable line anchor" };

  const oldPath = comment.old_path ?? null;
  const base = { path: comment.path, oldPath, startLine: comment.startLine };

  if (!index) {
    return comment.side === "LEFT"
      ? { anchor: { ...base, line, lineType: "REMOVED" } }
      : { anchor: { ...base, line, lineType: "ADDED" } };
  }

  const file =
    index.get(comment.path) ?? (oldPath ? index.get(oldPath) : undefined);
  if (!file) return { reason: `${comment.path} is not part of the PR diff` };

  if (comment.side === "LEFT") {
    const entry = file.oldLines.get(line);
    if (entry === undefined) {
      return { reason: `old line ${line} is not part of the PR diff` };
    }
    if (entry === "removed") {
      return { anchor: { ...base, line, lineType: "REMOVED" } };
    }
    // An unchanged line exists on both sides; anchor it on the new file.
    return {
      anchor: {
        ...base,
        line: entry,
        lineType: "CONTEXT",
        startLine: null,
      },
    };
  }

  const entry = file.newLines.get(line);
  if (entry === undefined) {
    return { reason: `line ${line} is not part of the PR diff` };
  }
  if (entry === "added") {
    return { anchor: { ...base, line, lineType: "ADDED" } };
  }
  return { anchor: { ...base, line, lineType: "CONTEXT" } };
}

export function fallbackCommentBody(
  comment: ValidatedReviewComment,
  line: number | null,
  why = "could not be posted inline",
): string {
  const filePath =
    comment.side === "LEFT" ? (comment.old_path ?? comment.path) : comment.path;
  const location = line !== null ? `${filePath}:${line}` : filePath;
  return (
    `**\`${location}\`** (${why}, ` +
    `so the finding is posted as a regular comment)\n\n${comment.body}`
  );
}

export async function postReview(options: {
  client: BitbucketClient;
  comments: ValidatedReviewComment[];
  index: Map<string, FileLineIndex> | null;
  /** Commits the reviewed diff was computed between, when known. */
  diffRefs?: { fromHash: string; toHash: string } | null;
  /**
   * Set when inline anchors would land on the wrong code (the pull request
   * changed after the review and the client cannot pin anchors); every
   * finding then posts as a regular comment explaining why.
   */
  inlineBlockedReason?: string | null;
}): Promise<PostReviewResult> {
  const { client, comments, index } = options;
  const diffRefs = options.diffRefs ?? null;
  const blocked = options.inlineBlockedReason ?? null;
  const result: PostReviewResult = {
    posted: 0,
    fallbackPosted: 0,
    failures: [],
  };

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i]!;
    const line = validatedAnchorLine(comment);
    const label = `[${i + 1}/${comments.length}] ${comment.path}:${line ?? "?"}`;
    const resolved = resolveInlineAnchor(comment, index);

    let lastError = "";
    let posted = false;
    if (blocked) {
      lastError = blocked;
    } else if ("reason" in resolved) {
      lastError = resolved.reason;
    } else {
      const pinned = { ...resolved.anchor, diffRefs };
      const attempts: BitbucketInlineAnchor[] = [];
      if (pinned.startLine !== null && client.supportsMultiLineComments) {
        attempts.push(pinned);
      }
      // A refused range still posts on its end line.
      attempts.push({ ...pinned, startLine: null });
      for (const anchor of attempts) {
        try {
          await client.createInlineComment(comment.body, anchor);
          posted = true;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    if (posted) {
      result.posted += 1;
      console.log(`  ${label} posted inline`);
      continue;
    }

    try {
      await client.createComment(
        fallbackCommentBody(comment, line, blocked ?? undefined),
      );
      result.fallbackPosted += 1;
      console.log(`  ${label} posted as a regular comment (${lastError})`);
    } catch (fallbackError) {
      const message =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      const error = lastError
        ? `${lastError}; comment fallback failed: ${message}`
        : message;
      result.failures.push({ path: comment.path, line, error });
      console.warn(`  ${label} failed: ${error}`);
    }
  }
  return result;
}
