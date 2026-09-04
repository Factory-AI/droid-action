#!/usr/bin/env bun

/**
 * Deterministic GitHub posting step for the two-pass review pipeline.
 *
 * Pass 2 writes `review_validated.json` and has no GitHub mutation tools.
 * This step validates the model-written file, checks every anchor against
 * the precomputed PR diff, and creates one batched GitHub review.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as core from "@actions/core";
import { createOctokit } from "../github/api/client";
import {
  isEntityContext,
  parseGitHubContext,
  type ParsedGitHubContext,
} from "../github/context";
import {
  buildUnifiedDiffIndex,
  type FileLineIndex,
} from "../core/review/validated/diff";
import {
  parseValidatedReview,
  validatedAnchorLine,
  type ValidatedReviewComment,
} from "../core/review/validated/parse";
import type { ReviewPostResults } from "../core/review/tracking/types";
import {
  createGitHubCommentReview,
  type GitHubReviewCommentPayload,
  type GitHubReviewCreateClient,
} from "../github/operations/reviews";

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

function fitFallbackFindings(findings: FallbackFinding[]): {
  included: FallbackFinding[];
  omitted: FallbackFinding[];
} {
  const included: FallbackFinding[] = [];
  const omitted: FallbackFinding[] = [];

  for (const finding of findings) {
    const candidate = fallbackReviewBody([...included, finding]);
    if (Buffer.byteLength(candidate, "utf8") <= MAX_GITHUB_REVIEW_BODY_BYTES) {
      included.push(finding);
    } else {
      omitted.push(finding);
    }
  }

  return { included, omitted };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createReview(
  client: GitHubReviewClient,
  owner: string,
  repo: string,
  prNumber: number,
  comments: GitHubInlineComment[],
  fallback: FallbackFinding[],
): Promise<number | undefined> {
  return createGitHubCommentReview({
    client,
    owner,
    repo,
    prNumber,
    comments,
    ...(fallback.length > 0 ? { body: fallbackReviewBody(fallback) } : {}),
  });
}

/**
 * Makes exactly one GitHub API call. Known-invalid anchors and comments over
 * GitHub's inline limit are included in that same review's body. A failed
 * response is never retried here because an ambiguous network failure may
 * have created the review remotely.
 */
export async function postGitHubReview(options: {
  client: GitHubReviewClient;
  owner: string;
  repo: string;
  prNumber: number;
  comments: ValidatedReviewComment[];
  diff: string;
}): Promise<GitHubPostReviewResult> {
  const { client, owner, repo, prNumber, comments, diff } = options;
  const result: GitHubPostReviewResult = {
    reviewId: undefined,
    posted: 0,
    fallbackPosted: 0,
    failures: [],
  };
  if (comments.length === 0) return result;

  const prepared = prepareGitHubReview(comments, buildUnifiedDiffIndex(diff));
  const fallback = fitFallbackFindings(prepared.fallback);
  result.failures = fallback.omitted.map(({ comment }) => ({
    path: comment.path,
    line: validatedAnchorLine(comment),
    error: `finding exceeds the ${MAX_GITHUB_REVIEW_BODY_BYTES}-byte review body budget`,
  }));

  if (prepared.inline.length === 0 && fallback.included.length === 0) {
    return result;
  }

  try {
    result.reviewId = await createReview(
      client,
      owner,
      repo,
      prNumber,
      prepared.inline,
      fallback.included,
    );
    result.posted = prepared.inline.length;
    result.fallbackPosted = fallback.included.length;
    return result;
  } catch (error) {
    const message = errorMessage(error);
    result.failures = comments.map((comment) => ({
      path: comment.path,
      line: validatedAnchorLine(comment),
      error: message,
    }));
    return result;
  }
}

export async function run(
  options: {
    context?: ParsedGitHubContext;
    client?: GitHubReviewClient;
  } = {},
): Promise<GitHubPostResults> {
  const context = options.context ?? parseGitHubContext();
  if (!isEntityContext(context) || !context.isPR) {
    throw new Error("github-post-review requires a pull request context");
  }

  const validatedPath = validatedReviewFilePath();
  let validatedRaw: string;
  try {
    validatedRaw = await fs.readFile(validatedPath, "utf8");
  } catch (error) {
    throw new Error(
      `github-post-review could not read validated review: ${errorMessage(error)}`,
    );
  }

  const parsed = parseValidatedReview(validatedRaw);
  let posted: GitHubPostReviewResult = {
    reviewId: undefined,
    posted: 0,
    fallbackPosted: 0,
    failures: [],
  };

  if (parsed.approved.length > 0) {
    const diffPath = reviewDiffFilePath();
    let diff: string;
    try {
      diff = await fs.readFile(diffPath, "utf8");
    } catch (error) {
      throw new Error(
        `github-post-review could not read PR diff: ${errorMessage(error)}`,
      );
    }

    const token = process.env.GITHUB_TOKEN;
    if (!options.client && !token) {
      throw new Error("GITHUB_TOKEN is required to post the review");
    }
    const client = options.client ?? createOctokit(token!);
    posted = await postGitHubReview({
      client,
      owner: context.repository.owner,
      repo: context.repository.repo,
      prNumber: context.entityNumber,
      comments: parsed.approved,
      diff,
    });
  }

  const results: GitHubPostResults = {
    posted: posted.posted,
    fallbackPosted: posted.fallbackPosted,
    approved: parsed.approvedCount,
    rejected: parsed.rejectedCount,
    failed: posted.failures.length,
    skipped: parsed.skipped.length,
    summaryBody: parsed.summaryBody,
    failures: posted.failures,
  };

  const resultsPath = githubPostResultsFilePath();
  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
  console.log(
    `Posted ${results.posted}/${parsed.approved.length} inline comments ` +
      `(${results.fallbackPosted} in the review body) on PR #${context.entityNumber} ` +
      `(results: ${resultsPath}).`,
  );

  if (
    parsed.approved.length > 0 &&
    results.posted === 0 &&
    results.fallbackPosted === 0
  ) {
    throw new Error(
      `github-post-review: all ${parsed.approved.length} approved comments failed to post. ` +
        `First error: ${results.failures[0]?.error ?? "unknown"}`,
    );
  }

  core.setOutput("conclusion", "success");
  return results;
}

if (import.meta.main) {
  run().catch((error) => {
    const message = errorMessage(error);
    console.error("github-post-review failed:", message);
    core.setOutput("conclusion", "failure");
    core.setOutput("error_message", message);
    process.exit(1);
  });
}
