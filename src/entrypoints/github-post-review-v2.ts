import * as path from "path";
import * as core from "@actions/core";
import {
  buildUnifiedDiffIndex,
  type FileLineIndex,
} from "../core/review/validated/diff";
import {
  validatedAnchorLine,
  type ValidatedReviewComment,
} from "../core/review/validated/parse";
import type { ReviewPostResults } from "../core/review/tracking/types";
import {
  createRenderedGitHubCommentReview as createGitHubCommentReview,
  type GitHubReviewCommentPayload,
  type GitHubReviewCreateClient,
} from "../github/operations/reviews";
import type { PrValidationRunType } from "../run-type";
import { normalizeFinding } from "../core/review/validated/finding";
import { decodeFindingMarker } from "../core/review/markers";
import type { ReviewFinding } from "../core/review/validated/types";
import { renderInlineComment, renderReviewBody } from "../core/review/render";
import type { RenderOptions } from "../core/review/render/types";
import { isPermissionError } from "../github/operations/review-checks";
import { redactCredentials } from "../utils/redact-credentials";
import { GITHUB_SERVER_URL } from "../github/api/config";

export const MAX_GITHUB_REVIEW_COMMENTS = 30;
export const MAX_GITHUB_REVIEW_BODY_BYTES = 60 * 1024;

type GitHubInlineComment = GitHubReviewCommentPayload & {
  line: number;
  side: "LEFT" | "RIGHT";
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
};

export type GitHubReviewClient = GitHubReviewCreateClient;

type FallbackFinding = {
  comment: ValidatedReviewComment;
  reason: string;
};

export type GitHubPostReviewResult = {
  reviewId: number | undefined;
  posted: number;
  fallbackPosted: number;
  failures: Array<{ path: string; line: number | null; error: string }>;
  findings?: ReviewFinding[];
};

export type GitHubPostResults = ReviewPostResults;

function promptsDir(): string {
  return path.join(process.env.RUNNER_TEMP || "/tmp", "droid-prompts");
}

export function validatedReviewFilePath(): string {
  return (
    process.env.REVIEW_VALIDATED_PATH ||
    path.join(promptsDir(), "review_validated.json")
  );
}

export function reviewDiffFilePath(): string {
  return process.env.REVIEW_DIFF_PATH || path.join(promptsDir(), "pr.diff");
}

export function githubPostResultsFilePath(): string {
  return (
    process.env.REVIEW_POST_RESULTS_PATH ||
    path.join(promptsDir(), "review_post_results.json")
  );
}

function indexedLine(
  comment: ValidatedReviewComment,
  file: FileLineIndex | undefined,
): boolean {
  const line = validatedAnchorLine(comment);
  if (line === null || !file) return false;
  return comment.side === "LEFT"
    ? file.oldLines.has(line)
    : file.newLines.has(line);
}

function inlineComment(
  comment: ValidatedReviewComment,
  file: FileLineIndex,
): GitHubInlineComment {
  const line = validatedAnchorLine(comment)!;
  const result: GitHubInlineComment = {
    path: comment.path,
    body: comment.body,
    line,
    side: comment.side,
  };

  if (
    comment.startLine !== null &&
    comment.startLine < line &&
    (comment.side === "LEFT"
      ? file.oldLines.has(comment.startLine)
      : file.newLines.has(comment.startLine))
  ) {
    result.start_line = comment.startLine;
    result.start_side = comment.side;
  }

  return result;
}

/**
 * Turns approved comments into API-ready inline anchors and review-body
 * fallbacks. This runs before posting, so known-bad lines never reach GitHub.
 */
export function prepareGitHubReview(
  comments: ValidatedReviewComment[],
  diffIndex: Map<string, FileLineIndex>,
): { inline: GitHubInlineComment[]; fallback: FallbackFinding[] } {
  const inline: GitHubInlineComment[] = [];
  const fallback: FallbackFinding[] = [];

  for (const comment of comments) {
    const file =
      diffIndex.get(comment.path) ??
      (comment.old_path ? diffIndex.get(comment.old_path) : undefined);
    const line = validatedAnchorLine(comment);

    if (!indexedLine(comment, file)) {
      fallback.push({
        comment,
        reason:
          line === null
            ? "no usable line anchor"
            : `${comment.side === "LEFT" ? "old line" : "line"} ${line} is not part of the PR diff`,
      });
      continue;
    }

    if (inline.length >= MAX_GITHUB_REVIEW_COMMENTS) {
      fallback.push({
        comment,
        reason: `GitHub reviews accept at most ${MAX_GITHUB_REVIEW_COMMENTS} inline comments`,
      });
      continue;
    }

    inline.push(inlineComment(comment, file!));
  }

  return { inline, fallback };
}

export function fallbackReviewBody(findings: FallbackFinding[]): string {
  const sections = findings.map(({ comment, reason }) => {
    const line = validatedAnchorLine(comment);
    const location = line === null ? comment.path : `${comment.path}:${line}`;
    return `### \`${location}\`\n\n${comment.body}\n\n<sub>Posted in the review body because ${reason}.</sub>`;
  });

  return [
    "## Findings without inline anchors",
    "",
    "These approved findings could not be attached to an inline diff position.",
    "",
    ...sections,
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return redactCredentials(
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * Makes exactly one GitHub API call. Known-invalid anchors and comments over
 * GitHub's inline limit are included in that same review's body. A failed
 * response is never retried here because an ambiguous network failure may
 * have created the review remotely.
 *
 * `commitId` is the head SHA the validator reviewed; passing it keeps the
 * anchors bound to that commit even if the PR head has moved since.
 */
export async function postGitHubReview(options: {
  client: GitHubReviewClient;
  owner: string;
  repo: string;
  prNumber: number;
  comments: ValidatedReviewComment[];
  diff: string;
  commitId?: string | null;
  runType?: PrValidationRunType;
  findings?: ReviewFinding[];
  renderOptions?: RenderOptions;
  warn?: (message: string) => void;
}): Promise<GitHubPostReviewResult> {
  const { client, owner, repo, prNumber, comments, diff } = options;
  const commitId = options.commitId ?? null;
  const result: GitHubPostReviewResult = {
    reviewId: undefined,
    posted: 0,
    fallbackPosted: 0,
    failures: [],
  };
  if (comments.length === 0)
    return {
      ...result,
      ...(options.findings ? { findings: options.findings } : {}),
    };

  const findings =
    options.findings ??
    comments.map((comment) => comment.finding ?? normalizeFinding(comment));
  const byId = new Map(findings.map((finding) => [finding.id, { ...finding }]));
  const richComments = comments.map((comment) => {
    const finding = comment.finding ?? normalizeFinding(comment);
    return {
      ...comment,
      finding,
      body: renderInlineComment(finding, {
        ...options.renderOptions,
        head: commitId ?? undefined,
      }),
    };
  });
  const prepared = prepareGitHubReview(
    richComments,
    buildUnifiedDiffIndex(diff),
  );
  for (const fallback of prepared.fallback) {
    const finding = fallback.comment.finding!;
    byId.set(finding.id, { ...finding, outside_diff: true });
  }
  result.findings = [...byId.values()];
  result.fallbackPosted = prepared.fallback.length;
  // All findings remain visible in the sticky summary, including outside-diff-only runs.
  if (prepared.inline.length === 0) return result;

  try {
    result.reviewId = await createGitHubCommentReview({
      client,
      owner,
      repo,
      prNumber,
      comments: prepared.inline,
      commitId,
      runType: options.runType,
      rendered: true,
      body: renderReviewBody({
        ...options.renderOptions,
        state: "findings",
        head: commitId ?? undefined,
        findings: result.findings,
      }),
    });
    result.posted = prepared.inline.length;
    if (result.reviewId && client.rest.pulls.listCommentsForReview) {
      let postedComments;
      try {
        postedComments = await client.rest.pulls.listCommentsForReview({
          owner,
          repo,
          pull_number: prNumber,
          review_id: result.reviewId,
          per_page: 100,
        });
      } catch {
        /* Links can be recovered from threads on the next run. Never repost a successful review. */
      }
      if (postedComments)
        for (const posted of postedComments.data) {
          const marker = decodeFindingMarker(posted.body || "");
          const finding = marker ? byId.get(marker.id) : undefined;
          if (finding) {
            finding.threadId = posted.id;
            finding.threadUrl =
              posted.html_url ||
              `${GITHUB_SERVER_URL}/${owner}/${repo}/pull/${prNumber}#discussion_r${posted.id}`;
          }
        }
      result.findings = [...byId.values()];
    }
    return result;
  } catch (error) {
    const message = errorMessage(error);
    if (
      isPermissionError(error) ||
      (error &&
        typeof error === "object" &&
        "status" in error &&
        error.status === 422)
    ) {
      if (isPermissionError(error))
        (options.warn ?? core.warning)(
          "Droid could not post inline comments. Check pull-requests: write permissions. Findings are preserved in the review summary.",
        );
      result.findings = findings.map((finding) => ({
        ...finding,
        outside_diff: true,
      }));
      result.fallbackPosted = comments.length;
      return result;
    }
    // Ambiguous failures are not retried. Preserve every finding in the summary.
    result.findings = findings.map((finding) => ({
      ...finding,
      outside_diff: true,
    }));
    result.failures = comments.map((comment) => ({
      path: comment.path,
      line: validatedAnchorLine(comment),
      error: message,
    }));
    return result;
  }
}
