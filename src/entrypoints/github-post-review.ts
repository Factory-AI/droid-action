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
import { createHash } from "crypto";
import { createOctokit } from "../github/api/client";
import type { Octokits } from "../github/api/client";
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
import {
  parsePrValidationRunType,
  type PrValidationRunType,
} from "../run-type";
import {
  normalizeFinding,
  SECURITY_SEVERITY_RANK,
} from "../core/review/validated/finding";
import {
  decodeFindingMarker,
  decodeReviewMarker,
} from "../core/review/markers";
import type { ReviewFinding } from "../core/review/validated/types";
import {
  renderInlineComment,
  renderReviewBody,
  renderStaleReviewBody,
} from "../core/review/render";
import type {
  RenderOptions,
  ReviewRenderInput,
} from "../core/review/render/types";
import {
  changedFindingCandidates,
  changedReviewLines,
  reconcileFindings,
} from "../core/review/incremental";
import {
  advanceReviewLifecycle,
  authoritativeReviewTarget,
  fetchImmutableReviewDiff,
  finishReviewLifecycle,
  lifecycleWarning,
  listDroidThreads,
  loadBoundReviewLifecycle,
  resolveDroidThread,
  reopenDroidThread,
  saveReviewLifecycle,
  stateFindings,
  type ReviewSessionIdentity,
} from "../github/operations/review-lifecycle";
import {
  isPermissionError,
  optionalGitHubOperation,
  reviewCheckConclusion,
} from "../github/operations/review-checks";
import { redactCredentials } from "../utils/redact-credentials";
import { GITHUB_SERVER_URL } from "../github/api/config";
import { DROID_APP_BOT_ID } from "../github/bot-identity";
import {
  reviewConfigFromEnvironment,
  shouldIgnoreReviewPath,
} from "../core/review/config";
import { enrichReviewSummary } from "../core/review/validated/metadata";

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
  const start = comment.startLine ?? line;
  if (!Number.isSafeInteger(start) || start < 1 || start > line) return false;
  const lines = comment.side === "LEFT" ? file.oldLines : file.newLines;
  // Never narrow a rendered replacement to only its final line.
  for (let current = start; current <= line; current++) {
    if (!lines.has(current)) return false;
  }
  return true;
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

export async function run(
  options: {
    context?: ParsedGitHubContext;
    client?: GitHubReviewClient;
    octokit?: Octokits;
    reviewSession?: ReviewSessionIdentity;
  } = {},
): Promise<GitHubPostResults> {
  let context = options.context ?? parseGitHubContext();
  const target = options.context ? undefined : authoritativeReviewTarget();
  if (target)
    context = {
      ...context,
      repository: {
        owner: target.owner,
        repo: target.repo,
        full_name: `${target.owner}/${target.repo}`,
      },
      entityNumber: target.prNumber,
      isPR: true,
    } as ParsedGitHubContext;
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
  if (parsed.conflictingCommitIds)
    throw new Error("Validated review declares conflicting commit identities.");
  let posted: GitHubPostReviewResult = {
    reviewId: undefined,
    posted: 0,
    fallbackPosted: 0,
    failures: [],
  };

  const token = process.env.GITHUB_TOKEN;
  const octokit =
    options.octokit ??
    (!options.client && token ? createOctokit(token) : undefined);
  const lifecycle = octokit
    ? await loadBoundReviewLifecycle(octokit, options.reviewSession)
    : null;
  if (lifecycle?.superseded) {
    await finishReviewLifecycle({
      octokit: octokit!,
      run: lifecycle,
      input: {
        state: "skipped",
        skipReason: "Superseded by a newer PR head or review.",
      },
    });
    throw new Error(
      "Review was superseded by a newer PR head or review; no findings were posted.",
    );
  }
  const expectedHead = target?.head || lifecycle?.head;
  if (expectedHead && parsed.commitId && parsed.commitId !== expectedHead)
    throw new Error(
      "Validated review head does not match the prepared immutable PR head.",
    );
  const commitId = expectedHead || parsed.commitId;
  let diff = "";
  if (parsed.findings.length > 0 || lifecycle) {
    const diffPath = reviewDiffFilePath();
    try {
      diff = await fs.readFile(diffPath, "utf8");
    } catch (error) {
      throw new Error(
        `github-post-review could not read PR diff: ${errorMessage(error)}`,
      );
    }
  }
  let findings = parsed.findings;
  const config = reviewConfigFromEnvironment();
  const priority = { P0: 0, P1: 1, P2: 2 };
  const excluded = findings.filter(
    (finding) =>
      shouldIgnoreReviewPath(finding.path, config) ||
      priority[finding.severity] > priority[config.review_severity_threshold] ||
      (finding.security &&
        finding.securitySeverity &&
        SECURITY_SEVERITY_RANK[finding.securitySeverity] >
          SECURITY_SEVERITY_RANK[config.security_severity_threshold]),
  );
  const excludedIds = new Set(excluded.map((finding) => finding.id));
  findings = findings.filter((finding) => !excludedIds.has(finding.id));
  const dropped = [
    ...parsed.dropped,
    ...excluded.map((finding, index) => ({
      index: parsed.approvedCount + parsed.rejectedCount + index,
      path: finding.path,
      title: finding.title,
      reason: shouldIgnoreReviewPath(finding.path, config)
        ? "Ignored by review_ignore_paths"
        : "Below the configured severity threshold",
    })),
  ];
  let newFindings = findings;
  let resolved: ReviewFinding[] = [];
  let unchangedSuggestions = 0;
  let threads: Awaited<ReturnType<typeof listDroidThreads>> = [];
  if (lifecycle && octokit) {
    await advanceReviewLifecycle({
      octokit,
      run: lifecycle,
      name: "Posting review",
    });
    threads =
      (await optionalGitHubOperation(
        () =>
          listDroidThreads({
            octokit,
            owner: lifecycle.owner,
            repo: lifecycle.repo,
            prNumber: lifecycle.prNumber,
          }),
        lifecycleWarning(lifecycle),
      )) ?? [];
    const previous = stateFindings(lifecycle.state);
    for (const thread of threads) {
      if (previous.some((finding) => finding.id === thread.findingId)) continue;
      const marker = decodeFindingMarker(thread.body)!;
      const remembered = lifecycle.state.findings.find(
        (finding) => finding.id === thread.findingId,
      );
      previous.push({
        ...normalizeFinding({
          id: marker.id,
          severity: marker.sev,
          category: marker.cat,
          security: marker.cat === "security",
          title:
            /\*\*([^*\n]+)\*\*/.exec(thread.body)?.[1] ||
            remembered?.title ||
            "Finding from an earlier review",
          path: thread.path,
          line: thread.line,
          body: remembered?.body || thread.body,
        }),
        threadId: thread.nodeId,
        threadUrl: thread.url,
        state: remembered?.state || (thread.resolved ? "dismissed" : "open"),
        isNew: false,
      });
    }
    const authoritativeDiff =
      lifecycle.base || lifecycle.pullRequest?.baseSha
        ? await optionalGitHubOperation(
            () =>
              fetchImmutableReviewDiff(octokit, {
                owner: lifecycle.owner,
                repo: lifecycle.repo,
                base: lifecycle.base || lifecycle.pullRequest!.baseSha,
                head: lifecycle.head,
              }),
            lifecycleWarning(lifecycle),
          )
        : undefined;
    diff = authoritativeDiff ?? "";
    const priorDiff =
      lifecycle.state.head && /^[a-f0-9]{7,64}$/i.test(lifecycle.state.head)
        ? await optionalGitHubOperation(
            () =>
              fetchImmutableReviewDiff(octokit, {
                owner: lifecycle.owner,
                repo: lifecycle.repo,
                base: lifecycle.state.head,
                head: lifecycle.head,
                direct: true,
              }),
            lifecycleWarning(lifecycle),
          )
        : undefined;
    const eligibleFixedIds =
      priorDiff === undefined
        ? []
        : changedFindingCandidates(previous, priorDiff).map(
            (finding) => finding.id,
          );
    const reconciled = reconcileFindings({
      previous,
      current: findings,
      threads: threads.map((thread) => ({
        findingId: thread.findingId,
        resolved: thread.resolved,
      })),
      eligibleFixedIds,
      fixedIds: parsed.fixedFindings.map((finding) => finding.id),
      head: commitId || lifecycle.head,
      incremental: !!lifecycle.incrementalBaseSha,
      changedPaths: new Set(changedReviewLines(priorDiff ?? diff).keys()),
    });
    const currentIds = new Set(findings.map((finding) => finding.id));
    findings = reconciled.findings.map((finding) => {
      const thread = threads.find((thread) => thread.findingId === finding.id);
      // The live location is on the current head, so apply it only after
      // eligibility has used the previous reviewed head's coordinates.
      if (
        currentIds.has(finding.id) ||
        !thread ||
        thread.side !== finding.side ||
        !thread.path ||
        thread.line === null ||
        !Number.isSafeInteger(thread.line) ||
        thread.line < 1
      )
        return finding;
      return {
        ...finding,
        path: thread.path,
        line: thread.line,
        startLine:
          thread.startLine &&
          Number.isSafeInteger(thread.startLine) &&
          thread.startLine > 0 &&
          thread.startLine < thread.line
            ? thread.startLine
            : null,
      };
    });
    newFindings = reconciled.newFindings;
    resolved = reconciled.resolved;
    unchangedSuggestions = reconciled.unchangedSuggestions;
    for (const finding of findings) {
      if (
        finding.state === "open" &&
        finding.pendingThreadAction === "reopen"
      ) {
        const thread = threads.find(
          (thread) => thread.findingId === finding.id,
        );
        if (thread) {
          await optionalGitHubOperation(
            () => reopenDroidThread({ octokit, thread }),
            lifecycleWarning(lifecycle),
          );
          if (!thread.resolved) finding.pendingThreadAction = undefined;
        }
      }
    }
    if (config.review_auto_resolve) {
      for (const finding of findings.filter(
        (finding) => finding.state === "resolved" && finding.fixedIn,
      )) {
        const thread = threads.find(
          (thread) => thread.findingId === finding.id,
        );
        // A fixed reply is a create, not an idempotent thread mutation. Try
        // it only for a newly validated fix, never on ambiguous retries.
        let reply =
          previous.find((prior) => prior.id === finding.id)?.state !==
          "resolved";
        if (thread && !thread.resolved)
          await optionalGitHubOperation(() => {
            const sendReply = reply;
            reply = false;
            return resolveDroidThread({
              octokit,
              owner: lifecycle.owner,
              repo: lifecycle.repo,
              prNumber: lifecycle.prNumber,
              thread,
              head: finding.fixedIn,
              reply: sendReply,
            });
          }, lifecycleWarning(lifecycle));
        if (thread?.resolved) finding.pendingThreadAction = undefined;
      }
    }
  }
  const renderOptions: RenderOptions = {
    head: commitId || lifecycle?.head,
    base: lifecycle?.base,
    repositoryUrl: `${GITHUB_SERVER_URL}/${context.repository.owner}/${context.repository.repo}`,
    summaryUrl:
      config.review_summary === "off"
        ? undefined
        : config.review_summary === "description"
          ? `${GITHUB_SERVER_URL}/${context.repository.owner}/${context.repository.repo}/pull/${context.entityNumber}#droid-review-summary`
          : lifecycle?.commentId
            ? `${GITHUB_SERVER_URL}/${context.repository.owner}/${context.repository.repo}/pull/${context.entityNumber}#issuecomment-${lifecycle.commentId}`
            : undefined,
    jobUrl: `${GITHUB_SERVER_URL}/${context.repository.owner}/${context.repository.repo}/actions/runs/${context.runId}`,
    depth: config.review_depth,
    model:
      process.env.REVIEW_EFFECTIVE_MODEL ||
      process.env.REVIEW_MODEL ||
      "default",
    reasoning:
      process.env.REVIEW_EFFECTIVE_REASONING ||
      process.env.REASONING_EFFORT ||
      undefined,
    badges: config.review_badges,
    includeCategories: config.review_category_chips,
    includeAgentPrompts: config.include_agent_prompts,
    showDroppedFindings: config.show_dropped_findings,
    diagram: config.review_diagram,
    sections: config.review_summary_sections,
  };
  const newIds = new Set(newFindings.map((finding) => finding.id));
  dropped.push(
    ...parsed.findings
      .filter(
        (finding) => !excludedIds.has(finding.id) && !newIds.has(finding.id),
      )
      .map((finding, index) => ({
        index:
          parsed.approvedCount + parsed.rejectedCount + excluded.length + index,
        path: finding.path,
        title: finding.title,
        reason:
          finding.optionalSuggestion && !finding.security
            ? "Optional suggestion on unchanged code was not posted"
            : "Already tracked or dismissed in an earlier review",
      })),
  );
  const comments = parsed.approved.filter((comment) =>
    newIds.has((comment.finding ?? normalizeFinding(comment)).id),
  );
  if (comments.length > 0) {
    if (!options.client && !octokit) {
      throw new Error("GITHUB_TOKEN is required to post the review");
    }
    const client = options.client ?? octokit!;
    if (!parsed.commitId) {
      core.warning(
        "review_validated.json names no single head SHA; posting against the PR's current head",
      );
    }
    posted = await postGitHubReview({
      client,
      owner: context.repository.owner,
      repo: context.repository.repo,
      prNumber: context.entityNumber,
      comments,
      diff,
      commitId,
      runType: parsePrValidationRunType(process.env.DROID_EXEC_RUN_TYPE),
      findings: newFindings,
      renderOptions,
      warn: lifecycle ? lifecycleWarning(lifecycle) : undefined,
    });
    const updated = new Map(
      posted.findings?.map((finding) => [finding.id, finding]),
    );
    findings = findings.map((finding) => updated.get(finding.id) ?? finding);
  }

  posted.fallbackPosted += newFindings.filter(
    (finding) => finding.outside_diff,
  ).length;
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
  await fs.writeFile(
    resultsPath,
    redactCredentials(JSON.stringify(results, null, 2)),
  );
  if (lifecycle && octokit) {
    const head = commitId || lifecycle.head;
    const previousHead = lifecycle.state.head;
    lifecycle.state = {
      ...lifecycle.state,
      ...(posted.failures.length
        ? {}
        : {
            head,
            base: lifecycle.base,
            diffHash: createHash("sha256").update(diff).digest("hex"),
          }),
      reviewed: [...new Set([...(lifecycle.state.reviewed || []), head])].slice(
        -100,
      ),
      autoRunCount:
        (lifecycle.state.autoRunCount || 0) +
        (lifecycle.automatic && !posted.failures.length ? 1 : 0),
      findings: findings.map((finding) => {
        const thread = threads.find(
          (thread) => thread.findingId === finding.id,
        );
        return {
          id: finding.id,
          sev: finding.severity,
          state: finding.state || "open",
          path: finding.path,
          ...(finding.line ? { line: finding.line } : {}),
          title: finding.title,
          body: finding.body,
          finding,
          thread: finding.threadId,
          threadId: thread?.nodeId,
          commentId:
            thread?.commentId ||
            (typeof finding.threadId === "number"
              ? finding.threadId
              : undefined),
          url: thread?.url || finding.threadUrl,
        };
      }),
    };
    const input: ReviewRenderInput = {
      ...renderOptions,
      state: posted.failures.length
        ? "failed"
        : findings.some((finding) => !finding.state || finding.state === "open")
          ? "findings"
          : "clean",
      findings,
      resolved,
      summary: {
        ...parsed.summary,
        security: {
          enabled: lifecycle.securityOnly || config.automatic_security_review,
          threshold: config.security_severity_threshold,
          blockOnCritical: config.security_block_on_critical,
          blockOnHigh: config.security_block_on_high,
        },
      },
      dropped,
      candidatesConsidered: parsed.approvedCount + parsed.rejectedCount,
      postedCount: posted.posted + posted.fallbackPosted,
      skippedCount: parsed.skipped.length,
      unchangedSuggestions,
      blocked:
        reviewCheckConclusion(findings, {
          failOnSeverity: config.fail_on_severity,
          securityBlockOnCritical: config.security_block_on_critical,
          securityBlockOnHigh: config.security_block_on_high,
        }) === "failure",
      error: posted.failures[0]?.error,
      previousBody: lifecycle.previousBody,
      previousHead,
    };
    let codeowners: string | undefined;
    if (
      config.review_suggest_reviewers &&
      lifecycle.base &&
      /^[a-f0-9]{7,64}$/i.test(lifecycle.base)
    ) {
      for (const file of [
        ".github/CODEOWNERS",
        "CODEOWNERS",
        "docs/CODEOWNERS",
      ]) {
        try {
          const response = await octokit.rest.repos.getContent({
            owner: lifecycle.owner,
            repo: lifecycle.repo,
            path: file,
            ref: lifecycle.base,
          });
          if (
            !Array.isArray(response.data) &&
            "content" in response.data &&
            response.data.encoding === "base64" &&
            response.data.size <= 3 * 1024 * 1024
          ) {
            codeowners = Buffer.from(response.data.content, "base64").toString(
              "utf8",
            );
            break;
          }
        } catch {
          /* A missing optional CODEOWNERS file is normal. */
        }
      }
    }
    const seenFiles = new Set<FileLineIndex>();
    const changedPaths = [...buildUnifiedDiffIndex(diff)]
      .filter(([, lines]) => {
        if (seenFiles.has(lines)) return false;
        seenFiles.add(lines);
        return true;
      })
      .map(([file]) => file);
    input.summary = enrichReviewSummary(input.summary || {}, {
      changedPaths,
      title: lifecycle.pullRequest?.title || "",
      description: lifecycle.pullRequest?.body || "",
      codeowners,
      suggestReviewers: config.review_suggest_reviewers,
      includeEffort: config.review_effort,
      preMergeChecks: config.review_pre_merge_checks,
      ignoredPaths: changedPaths
        .filter((file) => shouldIgnoreReviewPath(file, config))
        .map((path) => ({ path, reason: "Ignored by review_ignore_paths" })),
      security: input.summary?.security,
    });
    lifecycle.renderInput = input;
    await saveReviewLifecycle(lifecycle);
    if (!posted.failures.length)
      await markPreviousReviewsStale(
        octokit,
        context,
        head,
        lifecycleWarning(lifecycle),
      );
    await finishReviewLifecycle({
      octokit,
      run: lifecycle,
      input,
      error: posted.failures[0]?.error,
    });
  }
  console.log(
    `Posted ${results.posted}/${parsed.approved.length} inline comments ` +
      `(${results.fallbackPosted} in the summary) on PR #${context.entityNumber} ` +
      `(results: ${resultsPath}).`,
  );

  if (
    comments.length > 0 &&
    results.posted === 0 &&
    results.fallbackPosted === 0
  ) {
    throw new Error(
      `github-post-review: all ${parsed.approved.length} approved comments failed to post. ` +
        `First error: ${results.failures[0]?.error ?? "unknown"}`,
    );
  }

  core.setOutput("conclusion", "success");
  core.setOutput("review_posted", "true");
  return results;
}

async function markPreviousReviewsStale(
  octokit: Octokits,
  context: ParsedGitHubContext,
  head: string,
  warn: (message: string) => void,
): Promise<void> {
  await optionalGitHubOperation(async () => {
    for (let page = 1; ; page++) {
      const reviews = await octokit.rest.pulls.listReviews({
        owner: context.repository.owner,
        repo: context.repository.repo,
        pull_number: context.entityNumber,
        per_page: 100,
        page,
      });
      for (const review of reviews.data) {
        const marker = decodeReviewMarker(review.body || "");
        if (
          !marker ||
          marker.head === head ||
          marker.stale ||
          (review.user?.id !== DROID_APP_BOT_ID &&
            review.user?.login !== process.env.DROID_BOT_LOGIN)
        )
          continue;
        await octokit.rest.pulls.updateReview({
          owner: context.repository.owner,
          repo: context.repository.repo,
          pull_number: context.entityNumber,
          review_id: review.id,
          body: renderStaleReviewBody(marker.head, head),
        });
      }
      if (reviews.data.length < 100) break;
    }
  }, warn);
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
