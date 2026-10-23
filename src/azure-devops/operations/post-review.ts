/**
 * Turns approved findings into Azure DevOps PR threads.
 *
 * Each finding becomes one thread anchored with `threadContext` (file path
 * plus right- or left-side line range) and `pullRequestThreadContext`
 * (the file's `changeTrackingId` and the reviewed iteration), which is
 * what the Azure DevOps web UI itself sends. Findings that cannot be
 * anchored fall back to a general thread naming `path:line`.
 */

import type { FileLineIndex } from "../../core/review/validated/diff";
import {
  validatedAnchorLine,
  type ValidatedReviewComment,
} from "../../core/review/validated/parse";
import type { AzureDevopsClient } from "../api/client";
import type {
  AdoCreateThreadRequest,
  AdoIterationChange,
  AdoThreadContext,
} from "../types";

export type PostReviewResult = {
  posted: number;
  fallbackPosted: number;
  failures: Array<{ path: string; line: number | null; error: string }>;
};

/** Azure DevOps repository paths are rooted: `/src/a.ts`. */
export function toAdoPath(filePath: string): string {
  return filePath.startsWith("/") ? filePath : `/${filePath}`;
}

export function changeTrackingIds(
  changes: AdoIterationChange[],
): Map<string, number> {
  const ids = new Map<string, number>();
  for (const change of changes) {
    if (typeof change.changeTrackingId !== "number") continue;
    if (change.item?.path) ids.set(change.item.path, change.changeTrackingId);
    if (change.originalPath && !ids.has(change.originalPath)) {
      ids.set(change.originalPath, change.changeTrackingId);
    }
  }
  return ids;
}

/** Why the comment cannot anchor inline, or null when it can. */
function unanchorableReason(
  comment: ValidatedReviewComment,
  line: number,
  file: FileLineIndex | undefined,
): string | null {
  if (!file) return `${comment.path} is not part of the pull request diff`;
  const lines = comment.side === "LEFT" ? file.oldLines : file.newLines;
  if (!lines.has(line)) {
    return `${comment.side === "LEFT" ? "old line" : "line"} ${line} is not part of the pull request diff`;
  }
  return null;
}

export function buildThreadContext(
  comment: ValidatedReviewComment,
  startLine: number,
  endLine: number,
): AdoThreadContext {
  const start = { line: startLine, offset: 1 };
  const end = { line: endLine, offset: 1 };
  if (comment.side === "LEFT") {
    return {
      filePath: toAdoPath(comment.old_path ?? comment.path),
      leftFileStart: start,
      leftFileEnd: end,
    };
  }
  return {
    filePath: toAdoPath(comment.path),
    rightFileStart: start,
    rightFileEnd: end,
  };
}

export function fallbackCommentBody(
  comment: ValidatedReviewComment,
  line: number | null,
): string {
  const filePath =
    comment.side === "LEFT" ? (comment.old_path ?? comment.path) : comment.path;
  const location = line !== null ? `${filePath}:${line}` : filePath;
  return (
    `**\`${location}\`** (could not be posted inline, ` +
    `so the finding is posted as a general comment)\n\n${comment.body}`
  );
}

function findingThread(
  content: string,
  extra: Partial<AdoCreateThreadRequest> = {},
): AdoCreateThreadRequest {
  return {
    comments: [{ parentCommentId: 0, content, commentType: "text" }],
    status: "active",
    ...extra,
  };
}

export async function postReview(opts: {
  client: AzureDevopsClient;
  pullRequestId: number;
  iterationId: number;
  changes: AdoIterationChange[];
  diffIndex: Map<string, FileLineIndex> | null;
  comments: ValidatedReviewComment[];
}): Promise<PostReviewResult> {
  const { client, pullRequestId, iterationId, comments } = opts;
  const result: PostReviewResult = {
    posted: 0,
    fallbackPosted: 0,
    failures: [],
  };
  const trackingIds = changeTrackingIds(opts.changes);

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i]!;
    const line = validatedAnchorLine(comment);
    const label = `[${i + 1}/${comments.length}]`;
    const where = `${comment.path}:${line ?? "?"}`;
    let lastError = "";
    let posted = false;

    if (line === null) {
      lastError = "no usable line anchor";
    } else {
      const file =
        opts.diffIndex?.get(comment.path) ??
        (comment.old_path ? opts.diffIndex?.get(comment.old_path) : undefined);
      const reason = opts.diffIndex
        ? unanchorableReason(comment, line, file)
        : null;
      if (reason) {
        lastError = reason;
      } else {
        const lookupPath =
          comment.side === "LEFT"
            ? (comment.old_path ?? comment.path)
            : comment.path;
        const changeTrackingId =
          trackingIds.get(toAdoPath(lookupPath)) ??
          trackingIds.get(toAdoPath(comment.path));
        const pullRequestThreadContext = {
          ...(changeTrackingId !== undefined ? { changeTrackingId } : {}),
          // Equal iterations mean "merge base vs this iteration" (the full
          // PR diff the findings were made against). first=1 would instead
          // anchor against iteration 1's source, an inter-iteration diff.
          iterationContext: {
            firstComparingIteration: iterationId,
            secondComparingIteration: iterationId,
          },
        };

        // A multi-line range Azure DevOps refuses still posts as one line.
        const ranges: Array<[number, number]> = [];
        if (comment.startLine !== null && comment.startLine < line) {
          ranges.push([comment.startLine, line]);
        }
        ranges.push([line, line]);

        for (const [start, end] of ranges) {
          try {
            await client.createThread(
              pullRequestId,
              findingThread(comment.body, {
                threadContext: buildThreadContext(comment, start, end),
                pullRequestThreadContext,
              }),
            );
            posted = true;
            break;
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
      }
    }

    if (posted) {
      result.posted += 1;
      console.log(`  ${label} posted ${where}`);
      continue;
    }

    try {
      await client.createThread(
        pullRequestId,
        findingThread(fallbackCommentBody(comment, line)),
      );
      result.fallbackPosted += 1;
      console.log(
        `  ${label} posted ${where} as a general comment (${lastError})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const combined = lastError
        ? `${lastError}; general comment fallback failed: ${message}`
        : message;
      result.failures.push({ path: comment.path, line, error: combined });
      console.warn(`  ${label} failed ${where}: ${combined}`);
    }
  }

  return result;
}
