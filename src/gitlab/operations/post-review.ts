/**
 * Posting layer for GitLab MR reviews.
 *
 * Owns everything about turning a review comment (path + line + side)
 * into a GitLab diff position and creating the discussion. Two callers
 * share it:
 *
 *   - `src/entrypoints/gitlab-post-review.ts` — the CI step that posts
 *     the validated findings straight through the REST API (the default
 *     path for the CI/CD Component).
 *   - `src/mcp/gitlab-mr-server.ts` — the optional MCP `submit_review`
 *     tool, for workflows that let the agent post its own findings.
 *
 * GitLab rejects a diff position whose line anchor does not exist in the
 * MR's diff, so `postReview` degrades instead of losing a finding:
 * multi-line anchors fall back to their single-line form, and a comment
 * that still cannot be anchored is reported in `discussionErrors` rather
 * than aborting the remaining comments.
 */

import { createHash } from "crypto";
import type { GitlabClient } from "../api/client";
import type { GitlabPosition } from "../types";

export type ReviewCommentSide = "LEFT" | "RIGHT";

export type ReviewCommentInput = {
  path: string;
  body: string;
  line?: number | null;
  /** Start line for a multi-line anchor; null/equal-to-line means single-line. */
  startLine?: number | null;
  side?: ReviewCommentSide | null;
  old_path?: string | null;
  old_line?: number | null;
};

export type GitlabDiffRefs = {
  base_sha: string;
  head_sha: string;
  start_sha: string;
};

export type DiscussionError = {
  index: number;
  path: string;
  line: number | null;
  error: string;
};

export type PostReviewResult = {
  summaryNoteId: number | null;
  discussionsCreated: number;
  discussionErrors: DiscussionError[];
};

export type PostReviewOptions = {
  client: GitlabClient;
  projectId: string | number;
  mrIid: number;
  /** Optional top-level summary note posted before the inline comments. */
  body?: string | null;
  comments?: ReviewCommentInput[] | null;
  /** Pre-fetched diff refs; fetched from the MR when omitted. */
  diffRefs?: GitlabDiffRefs | null;
  /** Called after each comment attempt so callers can stream progress. */
  onProgress?: (event: {
    index: number;
    total: number;
    path: string;
    line: number | null;
    ok: boolean;
    error?: string;
  }) => void;
};

function resolveSide(comment: ReviewCommentInput): ReviewCommentSide {
  return comment.side === "LEFT" ? "LEFT" : "RIGHT";
}

/** The line the anchor ultimately points at, on whichever side applies. */
export function anchorLine(comment: ReviewCommentInput): number | null {
  const side = resolveSide(comment);
  if (side === "LEFT") {
    const left = comment.old_line ?? comment.line;
    return typeof left === "number" ? left : null;
  }
  return typeof comment.line === "number" ? comment.line : null;
}

/**
 * GitLab identifies a diff line by `<sha1(file path)>_<old line>_<new line>`,
 * using 0 for the side a line does not exist on. Only `line_range` anchors
 * (multi-line comments) need it.
 *
 * A span that covers unchanged context lines has a real number on both
 * sides, which this cannot reconstruct from a one-sided anchor; GitLab
 * rejects that `line_range` and `postReview` falls back to the single-line
 * anchor, so the comment lands but loses its span.
 */
export function lineCode(
  filePath: string,
  oldLine: number | null,
  newLine: number | null,
): string {
  const hash = createHash("sha1").update(filePath).digest("hex");
  return `${hash}_${oldLine ?? 0}_${newLine ?? 0}`;
}

export function buildPosition(
  comment: ReviewCommentInput,
  diffRefs: GitlabDiffRefs,
): GitlabPosition {
  const side = resolveSide(comment);
  const newPath = comment.path;
  const oldPath = comment.old_path ?? comment.path;

  const position: GitlabPosition = {
    base_sha: diffRefs.base_sha,
    start_sha: diffRefs.start_sha,
    head_sha: diffRefs.head_sha,
    position_type: "text",
    new_path: newPath,
    old_path: oldPath,
  };

  if (side === "LEFT") {
    const left = comment.old_line ?? comment.line;
    if (typeof left === "number") {
      position.old_line = left;
    }
  } else {
    if (typeof comment.line === "number") {
      position.new_line = comment.line;
    }
    if (typeof comment.old_line === "number") {
      position.old_line = comment.old_line;
    }
  }

  return position;
}

/**
 * Multi-line variant of {@link buildPosition}. Returns null when the
 * comment has no usable multi-line span, so callers can fall through to
 * the single-line anchor.
 */
export function buildMultiLinePosition(
  comment: ReviewCommentInput,
  diffRefs: GitlabDiffRefs,
): GitlabPosition | null {
  const end = anchorLine(comment);
  const start = comment.startLine ?? null;
  if (typeof start !== "number" || end === null || start >= end) {
    return null;
  }

  const side = resolveSide(comment);
  const type = side === "LEFT" ? ("old" as const) : ("new" as const);
  const base = buildPosition(comment, diffRefs);
  const pathForCode =
    side === "LEFT" ? (base.old_path ?? base.new_path) : base.new_path;

  return {
    ...base,
    line_range: {
      start: {
        line_code: lineCode(
          pathForCode,
          side === "LEFT" ? start : null,
          side === "LEFT" ? null : start,
        ),
        type,
      },
      end: {
        line_code: lineCode(
          pathForCode,
          side === "LEFT" ? end : null,
          side === "LEFT" ? null : end,
        ),
        type,
      },
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function postReview(
  options: PostReviewOptions,
): Promise<PostReviewResult> {
  const { client, projectId, mrIid, body, comments, onProgress } = options;

  const result: PostReviewResult = {
    summaryNoteId: null,
    discussionsCreated: 0,
    discussionErrors: [],
  };

  if (body && body.trim().length > 0) {
    const note = await client.createNote(projectId, mrIid, body);
    result.summaryNoteId = note.id;
  }

  if (!comments || comments.length === 0) {
    return result;
  }

  let diffRefs = options.diffRefs ?? null;
  if (!diffRefs) {
    const mr = await client.getMr(projectId, mrIid);
    diffRefs = mr.diff_refs ?? null;
  }
  if (!diffRefs) {
    throw new Error(
      "Merge request is missing diff_refs; cannot anchor inline comments",
    );
  }

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i]!;
    const line = anchorLine(comment);

    if (line === null) {
      const error =
        "Inline discussions require a line anchor: provide `line` for " +
        "side=RIGHT comments, or `old_line` for side=LEFT comments.";
      result.discussionErrors.push({
        index: i,
        path: comment.path,
        line,
        error,
      });
      onProgress?.({
        index: i,
        total: comments.length,
        path: comment.path,
        line,
        ok: false,
        error,
      });
      continue;
    }

    const attempts: GitlabPosition[] = [];
    const multiLine = buildMultiLinePosition(comment, diffRefs);
    if (multiLine) {
      attempts.push(multiLine);
    }
    attempts.push(buildPosition(comment, diffRefs));

    let posted = false;
    let lastError = "";
    for (const position of attempts) {
      try {
        await client.createDiscussionOnDiff(
          projectId,
          mrIid,
          comment.body,
          position,
        );
        posted = true;
        break;
      } catch (error) {
        lastError = errorMessage(error);
      }
    }

    if (posted) {
      result.discussionsCreated += 1;
      onProgress?.({
        index: i,
        total: comments.length,
        path: comment.path,
        line,
        ok: true,
      });
    } else {
      result.discussionErrors.push({
        index: i,
        path: comment.path,
        line,
        error: lastError,
      });
      onProgress?.({
        index: i,
        total: comments.length,
        path: comment.path,
        line,
        ok: false,
        error: lastError,
      });
    }
  }

  return result;
}
