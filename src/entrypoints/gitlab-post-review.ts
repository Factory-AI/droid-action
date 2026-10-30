#!/usr/bin/env bun

/**
 * Posting step for the GitLab CI/CD Component: turns the
 * `review_validated.json` written by Pass 2 into inline MR discussions.
 *
 * `parseValidatedReview` (shared in `src/core/review/validated/parse.ts`)
 * is the trust boundary — the file comes from a model, so only entries
 * explicitly marked `"approved"` with a usable line anchor can post. A hard
 * failure (no state, no validated file, unusable JSON, API refusing every
 * call) exits non-zero so the tracking note reports failure; a single
 * comment that will not anchor is recorded and the step still succeeds.
 *
 * Inputs (env): GITLAB_TOKEN, CI_PROJECT_ID, CI_MERGE_REQUEST_IID,
 * DROID_STATE_FILE, REVIEW_VALIDATED_PATH, REVIEW_POST_RESULTS_PATH,
 * CI_API_V4_URL. The project and MR always come from the CI variables; the
 * state file is writable by the review passes, so it can only confirm them.
 */

import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { setupGitlabToken } from "../gitlab/token";
import { GitlabClient } from "../gitlab/api/client";
import { resolvePostTarget } from "../gitlab/operations/post-target";
import type { GitlabMrDiff, GitlabPosition } from "../gitlab/types";
import {
  buildFileLineIndex,
  type FileLineIndex,
} from "../core/review/validated/diff";
import {
  InvalidValidatedReviewError,
  parseValidatedReview,
  validatedAnchorLine,
  type ParsedValidatedReview,
  type ValidatedReviewComment,
} from "../core/review/validated/parse";
import type { ReviewPostResults } from "../core/review/tracking/types";
import {
  promptsDir,
  stateFilePath,
  validatedFilePath,
  type PrepareState,
} from "./gitlab-prepare";
import {
  normalizeFinding,
  SECURITY_SEVERITY_RANK,
} from "../core/review/validated/finding";
import {
  renderInlineComment,
  type RenderOptions,
  type ReviewRenderInput,
} from "../core/review/render";
import type { ReviewFinding } from "../core/review/validated/types";
import {
  discussionFinding,
  findingFromState,
  loadReviewMemory,
  resolveFixedDiscussions,
  stateFinding,
  warnCapability,
} from "../gitlab/operations/review-ux";
import {
  changedFindingCandidates,
  reconcileFindings,
} from "../core/review/incremental";
import { buildDiffContent } from "../gitlab/data/review-artifacts";
import { enrichReviewSummary } from "../core/review/validated/metadata";
import { isMissingFile } from "../gitlab/operations/review-ux";
import { publishGitlabSecurityReport } from "../gitlab/operations/security-report";
import { shouldIgnoreReviewPath } from "../core/review/config";
import { loadGitlabReviewConfig } from "../gitlab/operations/review-config";
import { decodeReviewState, encodeReviewState } from "../core/review/markers";
import { fitInlineOutput } from "../core/review/render/budget";
import { parseSecurityReport } from "../core/review/security-report";

export type ReviewComment = ValidatedReviewComment;
export {
  InvalidValidatedReviewError,
  parseValidatedReview,
  type ParsedValidatedReview,
};
export type { FileLineIndex };

export type PostResults = ReviewPostResults & {
  renderInput?: ReviewRenderInput;
};

/** Written here, read by gitlab-update-comment-link. */
export function postResultsFilePath(): string {
  return (
    process.env.REVIEW_POST_RESULTS_PATH ||
    path.join(promptsDir(), "review_post_results.json")
  );
}

// --- diff index ------------------------------------------------------------

/** Indexes every hunk line, keyed by both `new_path` and `old_path`. */
export function buildDiffIndex(
  changes: GitlabMrDiff[],
): Map<string, FileLineIndex> {
  const files = new Map<string, FileLineIndex>();

  for (const change of changes) {
    if (typeof change?.diff !== "string") continue;
    const index = buildFileLineIndex(change.diff);

    if (change.new_path) files.set(change.new_path, index);
    if (change.old_path && change.old_path !== change.new_path) {
      files.set(change.old_path, index);
    }
  }

  return files;
}

// --- posting ---------------------------------------------------------------

type DiffRefs = { base_sha: string; head_sha: string; start_sha: string };

export type PostReviewResult = {
  posted: number;
  /** Comments that went out as plain MR notes because they cannot anchor. */
  fallbackPosted: number;
  failures: Array<{ path: string; line: number | null; error: string }>;
};

const anchorLine = validatedAnchorLine;

/**
 * GitLab identifies a diff line by `<sha1(path)>_<old line>_<new line>`,
 * using 0 for the side the line does not exist on. Only `line_range`
 * (multi-line) anchors need it. A span over unchanged context lines has a
 * real number on *both* sides, which cannot be reconstructed from a
 * one-sided anchor, so GitLab rejects it and posting falls back to a
 * single line.
 */
function lineCode(
  filePath: string,
  oldLine: number | null,
  newLine: number | null,
): string {
  const hash = createHash("sha1").update(filePath).digest("hex");
  return `${hash}_${oldLine ?? 0}_${newLine ?? 0}`;
}

function buildPosition(
  comment: ReviewComment,
  diffRefs: DiffRefs,
): GitlabPosition {
  const position: GitlabPosition = {
    base_sha: diffRefs.base_sha,
    start_sha: diffRefs.start_sha,
    head_sha: diffRefs.head_sha,
    position_type: "text",
    new_path: comment.path,
    old_path: comment.old_path ?? comment.path,
  };

  if (comment.side === "LEFT") {
    const left = comment.old_line ?? comment.line;
    if (left !== null) {
      position.old_line = left;
    }
    return position;
  }

  if (comment.line !== null) {
    position.new_line = comment.line;
  }
  if (comment.old_line !== null) {
    position.old_line = comment.old_line;
  }
  return position;
}

/**
 * Reshapes `base` to the anchor form GitLab accepts for the line's role in
 * the diff (added / removed / context), or names the reason no positioned
 * discussion can ever work for this comment.
 */
function refineWithIndex(
  comment: ReviewComment,
  base: GitlabPosition,
  file: FileLineIndex | undefined,
): { position: GitlabPosition } | { reason: string } {
  const line = anchorLine(comment);
  if (line === null) {
    return { reason: "no usable line anchor" };
  }

  if (comment.side === "LEFT") {
    const entry = file?.oldLines.get(line);
    if (entry === undefined) {
      return { reason: `old line ${line} is not part of the MR diff` };
    }
    const position = { ...base, old_line: line };
    if (entry === "removed") {
      delete position.new_line;
    } else {
      position.new_line = entry;
    }
    return { position };
  }

  const entry = file?.newLines.get(line);
  if (entry === undefined) {
    return { reason: `line ${line} is not part of the MR diff` };
  }
  const position = { ...base, new_line: line };
  if (entry === "added") {
    delete position.old_line;
  } else {
    position.old_line = entry;
  }
  return { position };
}

/** Multi-line variant of {@link buildPosition}; null when there is no span. */
function buildMultiLinePosition(
  comment: ReviewComment,
  base: GitlabPosition,
): GitlabPosition | null {
  const end = anchorLine(comment);
  const start = comment.startLine;
  if (start === null || end === null || start >= end) {
    return null;
  }

  const left = comment.side === "LEFT";
  const pathForCode = left ? (base.old_path ?? base.new_path) : base.new_path;
  const code = (line: number) =>
    lineCode(pathForCode, left ? line : null, left ? null : line);

  return {
    ...base,
    line_range: {
      start: { line_code: code(start), type: left ? "old" : "new" },
      end: { line_code: code(end), type: left ? "old" : "new" },
    },
  };
}

/** Body for the plain-note fallback when a comment cannot anchor inline. */
export function fallbackNoteBody(
  comment: ReviewComment,
  line: number | null,
): string {
  const filePath =
    comment.side === "LEFT" ? (comment.old_path ?? comment.path) : comment.path;
  const location = line !== null ? `${filePath}:${line}` : filePath;
  return (
    `**\`${location}\`** (could not be posted inline, ` +
    `so the finding is posted as a regular comment)\n\n${comment.body}`
  );
}

/**
 * Posts one discussion per comment; the summary goes into the tracking note
 * rather than a second top-level note. A comment whose line cannot anchor
 * inline (outside the diff, or refused by the API) falls back to a plain MR
 * note; only a comment that fails both routes lands in `failures`.
 */
export async function postReview(options: {
  client: GitlabClient;
  projectId: string | number;
  mrIid: number;
  comments: ReviewComment[];
  renderOptions?: RenderOptions;
  onPosted?: (finding: ReviewFinding) => void;
  onOutsideDiff?: (finding: ReviewFinding) => void;
}): Promise<PostReviewResult> {
  const { client, projectId, mrIid, comments } = options;
  const result: PostReviewResult = {
    posted: 0,
    fallbackPosted: 0,
    failures: [],
  };

  if (comments.length === 0) {
    return result;
  }

  const mr = await client.getMr(projectId, mrIid);
  if (
    process.env.DROID_REVIEW_HEAD_SHA &&
    process.env.DROID_REVIEW_HEAD_SHA !== mr.diff_refs.head_sha
  )
    throw new Error(
      "MR head changed after preparation; refusing to post a stale review",
    );
  const diffRefs = mr.diff_refs ?? null;
  if (!diffRefs) {
    throw new Error(
      "Merge request is missing diff_refs; cannot anchor inline comments",
    );
  }

  // The changes feed the line index that decides which anchor shape GitLab
  // will accept. Posting still works without it, one API refusal at a time.
  let diffIndex: Map<string, FileLineIndex> | null = null;
  try {
    const changes = await client.getMrChanges(projectId, mrIid);
    diffIndex = Array.isArray(changes?.changes)
      ? buildDiffIndex(changes.changes)
      : null;
  } catch (error) {
    console.warn(
      "Could not fetch MR changes; posting without a diff line index:",
      error instanceof Error ? error.message : String(error),
    );
  }

  for (let i = 0; i < comments.length; i++) {
    const comment = comments[i]!;
    const finding = comment.finding ?? normalizeFinding({ ...comment });
    const body = options.renderOptions
      ? fitInlineOutput(
          finding,
          options.renderOptions,
          (candidate, renderOptions) =>
            `${renderInlineComment(candidate, renderOptions)}\n\n${encodeReviewState(
              {
                head: mr.diff_refs.head_sha,
                findings: [stateFinding(candidate)],
              },
            )}`,
        )
      : comment.body;
    const line = anchorLine(comment);
    const where = `${comment.path}:${line ?? "?"}`;
    const label = `[${i + 1}/${comments.length}]`;

    const base = buildPosition(comment, diffRefs);
    const attempts: GitlabPosition[] = [];
    let lastError = "";

    if (diffIndex) {
      const file =
        diffIndex.get(comment.path) ??
        (comment.old_path !== null
          ? diffIndex.get(comment.old_path)
          : undefined);
      const refined = refineWithIndex(comment, base, file);
      if ("reason" in refined) {
        // Unanchorable no matter the payload; go straight to the fallback.
        lastError = refined.reason;
      } else {
        // A multi-line anchor GitLab refuses still posts as a single line.
        const multi = buildMultiLinePosition(comment, refined.position);
        if (multi) attempts.push(multi);
        attempts.push(refined.position);
      }
    } else {
      const multi = buildMultiLinePosition(comment, base);
      if (multi) attempts.push(multi);
      attempts.push(base);
    }

    let posted = false;
    for (const position of attempts) {
      try {
        const discussion = await client.createDiscussionOnDiff(
          projectId,
          mrIid,
          body,
          position,
        );
        options.onPosted?.({
          ...finding,
          threadId: discussion.id,
          ...(discussion.notes?.[0]?.id && mr.web_url
            ? { threadUrl: `${mr.web_url}#note_${discussion.notes[0].id}` }
            : {}),
        });
        posted = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (posted) {
      result.posted += 1;
      console.log(`  ${label} posted ${where}`);
      continue;
    }

    if (options.onOutsideDiff) {
      options.onOutsideDiff({ ...finding, outside_diff: true });
      result.fallbackPosted += 1;
      continue;
    }

    try {
      await client.createNote(
        projectId,
        mrIid,
        fallbackNoteBody(comment, line),
      );
      result.fallbackPosted += 1;
      console.log(
        `  ${label} posted ${where} as a regular note (${lastError})`,
      );
    } catch (noteError) {
      const noteMessage =
        noteError instanceof Error ? noteError.message : String(noteError);
      const error = lastError
        ? `${lastError}; note fallback failed: ${noteMessage}`
        : noteMessage;
      result.failures.push({ path: comment.path, line, error });
      console.warn(`  ${label} failed ${where}: ${error}`);
    }
  }

  return result;
}

// --- CI step ---------------------------------------------------------------

async function readState(): Promise<PrepareState | null> {
  const filePath = stateFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as PrepareState;
  } catch (err) {
    console.warn(`Could not read droid state file at ${filePath}:`, err);
    return null;
  }
}

async function run(): Promise<void> {
  const state = await readState();
  if (!state) {
    throw new Error(
      "gitlab-post-review: no state file; was gitlab-prepare run successfully?",
    );
  }

  if (!state.shouldRunReview) {
    console.log(
      `Review was skipped (reason: ${state.reason ?? "unknown"}); nothing to post.`,
    );
    return;
  }

  if (state.validatorSkippedReason) {
    // gitlab-prepare-validator short-circuited Pass 2 because Pass 1 left no
    // usable candidates file. There is nothing to post, and failing here
    // would undo that deliberate soft landing.
    console.log(
      `Pass 2 was skipped (reason: ${state.validatorSkippedReason}); nothing to post.`,
    );
    return;
  }

  if (!state.mrIid) {
    throw new Error("gitlab-post-review: state is missing mrIid");
  }
  const { projectId, mrIid } = resolvePostTarget(state);

  const validatedPath = state.validatedPath ?? validatedFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(validatedPath, "utf8");
  } catch {
    throw new Error(
      `gitlab-post-review: Pass 2 did not write ${validatedPath}; ` +
        "refusing to report a successful review with no posted findings.",
    );
  }

  const scan =
    process.env.DROID_SECURITY_FULL === "true"
      ? parseSecurityReport(raw, process.env.DROID_REVIEW_HEAD_SHA)
      : undefined;
  const parsed = scan?.review ?? parseValidatedReview(raw);

  console.log(
    `Validated review: ${parsed.approvedCount} approved, ` +
      `${parsed.rejectedCount} rejected, ${parsed.skipped.length} unusable.`,
  );
  for (const skip of parsed.skipped) {
    console.warn(
      `  skipped result #${skip.index}` +
        `${skip.path ? ` (${skip.path})` : ""}: ${skip.reason}`,
    );
  }

  const client = new GitlabClient(
    setupGitlabToken(),
    process.env.CI_API_V4_URL ||
      process.env.GITLAB_API_URL ||
      "https://gitlab.com/api/v4",
  );

  // Old installed templates can hand this entrypoint a pre-v2 state file.
  // New templates pin v2 in the parent environment, not model-writable state.
  if (!state.reviewConfig && process.env.REVIEW_UX_V2 !== "true") {
    const result = await postReview({
      client,
      projectId,
      mrIid,
      comments: parsed.approved,
    });
    const results: PostResults = {
      posted: result.posted,
      fallbackPosted: result.fallbackPosted,
      approved: parsed.approvedCount,
      rejected: parsed.rejectedCount,
      failed: result.failures.length,
      skipped: parsed.skipped.length,
      summaryBody: parsed.summaryBody,
      failures: result.failures,
    };
    await fs.mkdir(path.dirname(postResultsFilePath()), { recursive: true });
    await fs.writeFile(postResultsFilePath(), JSON.stringify(results, null, 2));
    if (
      parsed.approved.length > 0 &&
      results.posted === 0 &&
      results.fallbackPosted === 0
    )
      throw new Error(
        `gitlab-post-review: all ${parsed.approved.length} approved comments failed to post. First error: ${results.failures[0]?.error ?? "unknown"}`,
      );
    return;
  }

  // Every addressing hint from the model-writable state is checked against
  // current API data and a summary owned by this token's user.
  const mr = await client.getMr(projectId, mrIid);
  if (parsed.commitId && parsed.commitId !== mr.diff_refs.head_sha)
    throw new Error(
      "MR head changed after validation; refusing to post a stale review",
    );
  if (
    process.env.DROID_REVIEW_HEAD_SHA &&
    process.env.DROID_REVIEW_HEAD_SHA !== mr.diff_refs.head_sha
  )
    throw new Error(
      "MR head changed after preparation; refusing to post a stale review",
    );
  const config = await loadGitlabReviewConfig(client, projectId, mr);
  const memory = await loadReviewMemory(client, projectId, mrIid);
  let previous = memory.state ?? { head: "", findings: [] };
  let resolved: ReviewFinding[] = [];
  const fullChanges = await client.getMrChanges(projectId, mrIid);
  let actualChanges = fullChanges;
  let eligibleFixedIds = new Set<string>();
  let discussions: Awaited<ReturnType<GitlabClient["listDiscussions"]>> = [];
  try {
    discussions = await client.listDiscussions(projectId, mrIid);
  } catch (error) {
    warnCapability("discussion state", error);
  }
  // Recover a completed inline post after an interrupted run even if its
  // final summary/state write never happened. Only actual owned notes count.
  for (const discussion of discussions) {
    const owned = discussionFinding(discussion, memory.user.id);
    if (!owned || previous.findings.some((f) => f.id === owned.marker.id))
      continue;
    const saved = decodeReviewState(owned.note.body);
    const entry =
      saved && saved.head === owned.marker.head
        ? saved.findings.find((f) => f.id === owned.marker.id)
        : undefined;
    const position = owned.note.position;
    const candidate =
      parsed.findings.find((f) => f.id === owned.marker.id) ??
      (entry
        ? findingFromState(entry)
        : normalizeFinding({
            id: owned.marker.id,
            severity: owned.marker.sev,
            category: "recovered-unclassified",
            security: owned.marker.cat === "security",
            title: `Recovered finding ${owned.marker.id} (classification unavailable)`,
            verification:
              "The original classification could not be recovered. Revalidate this finding before clearing the review gate.",
            body: owned.note.body,
            path: position?.new_path || position?.old_path || "",
            line: position?.new_line ?? position?.old_line ?? null,
            old_path: position?.old_path,
            side: position?.new_line ? "RIGHT" : "LEFT",
          }));
    previous.findings.push(
      stateFinding({
        ...candidate,
        state: owned.note.resolved ? "dismissed" : "open",
        threadId: discussion.id,
        threadUrl: `${mr.web_url}#note_${owned.note.id}`,
      }),
    );
  }
  if (previous.head && previous.head !== mr.diff_refs.head_sha) {
    try {
      const comparison = await client.compare(
        projectId,
        previous.head,
        mr.diff_refs.head_sha,
      );
      if (comparison.compare_timeout)
        throw new Error("Incremental comparison timed out");
      actualChanges = { changes: comparison.diffs, diff_refs: mr.diff_refs };
      eligibleFixedIds = new Set(
        changedFindingCandidates(
          previous.findings
            .filter((f) => f.state === "open")
            .map(findingFromState),
          buildDiffContent(actualChanges),
        ).map((f) => f.id),
      );
    } catch (error) {
      warnCapability(
        "fixed-finding eligibility (auto-resolution skipped)",
        error,
      );
    }
  }
  const reviewChanges =
    state.fullReview || !config.review_incremental
      ? fullChanges
      : actualChanges;
  const changedPaths = reviewChanges.changes.map(
    (c) => c.new_path || c.old_path,
  );
  try {
    const fixed = await resolveFixedDiscussions({
      client,
      projectId,
      mr,
      state: previous,
      discussions,
      userId: memory.user.id,
      fixed: parsed.fixedFindings.filter((f) => eligibleFixedIds.has(f.id)),
      changedPaths,
      enabled: config.review_auto_resolve,
    });
    previous = fixed.state;
    resolved = fixed.resolved;
  } catch (error) {
    warnCapability("discussion state", error);
  }
  const normalizedTitle = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const dropped = [...parsed.dropped];
  const findings = parsed.findings
    .filter((finding, index) => {
      const reason = shouldIgnoreReviewPath(finding.path, config)
        ? "Ignored path (generated, lock file, or configured exclusion)"
        : process.env.DROID_SECURITY_ONLY === "true" && !finding.security
          ? "Not a security finding in a security-only review"
          : Number(finding.severity.slice(1)) >
              Number(config.review_severity_threshold.slice(1))
            ? `Below report priority threshold ${config.review_severity_threshold}`
            : finding.security &&
                finding.securitySeverity &&
                SECURITY_SEVERITY_RANK[finding.securitySeverity] >
                  SECURITY_SEVERITY_RANK[config.security_severity_threshold]
              ? `Below security threshold ${config.security_severity_threshold}`
              : null;
      if (reason)
        dropped.push({
          index,
          path: finding.path,
          title: finding.title,
          reason,
        });
      return !reason;
    })
    .map((finding) => {
      const known = previous.findings.find(
        (f) =>
          f.id === finding.id ||
          (f.path === finding.path &&
            f.title &&
            normalizedTitle(f.title) === normalizedTitle(finding.title)),
      );
      return known ? { ...finding, id: known.id } : finding;
    });
  const reconciled = reconcileFindings({
    previous: previous.findings.map(findingFromState),
    current: findings,
    head: mr.diff_refs.head_sha,
    incremental:
      Boolean(previous.head) && config.review_incremental && !state.fullReview,
    changedPaths: new Set(changedPaths),
  });
  const fresh = new Set(reconciled.newFindings.map((f) => f.id));
  const postedFindings: ReviewFinding[] = [];
  const outside = reconciled.newFindings.filter((f) => f.outside_diff);
  const renderOptions: RenderOptions = {
    platform: "gitlab",
    head: mr.diff_refs.head_sha,
    base: mr.diff_refs.base_sha,
    repositoryUrl: mr.web_url.split("/-/merge_requests/")[0],
    badges: config.review_badges,
    includeAgentPrompts: config.include_agent_prompts,
    includeCategories: config.review_category_chips,
  };
  const commentsToPost = parsed.approved.filter((comment) => {
    const candidate = comment.finding ?? normalizeFinding({ ...comment });
    return fresh.has(candidate.id) && !candidate.outside_diff;
  });

  const result = await postReview({
    client,
    projectId,
    mrIid,
    comments: commentsToPost,
    renderOptions,
    onPosted: (finding) =>
      postedFindings.push({ ...finding, state: "open", isNew: true }),
    onOutsideDiff: (finding) =>
      outside.push({ ...finding, state: "open", isNew: true }),
  });

  const all = [
    ...reconciled.findings.filter((f) => !fresh.has(f.id)),
    ...postedFindings,
    ...outside,
  ];
  const open = all.filter((f) => f.state === "open" || !f.state);
  const blocked = open.some(
    (f) =>
      (f.category === "recovered-unclassified" &&
        (config.security_block_on_critical || config.security_block_on_high)) ||
      (config.fail_on_severity &&
        Number(f.severity.slice(1)) <=
          Number(config.fail_on_severity.slice(1))) ||
      (f.security &&
        ((config.security_block_on_critical &&
          f.securitySeverity === "critical") ||
          (config.security_block_on_high &&
            ["critical", "high"].includes(f.securitySeverity ?? "")))),
  );
  const reviewState = {
    ...previous,
    head: mr.diff_refs.head_sha,
    base: mr.diff_refs.base_sha,
    depth: config.review_depth,
    reviewed: [
      ...new Set([...(previous.reviewed ?? []), mr.diff_refs.head_sha]),
    ],
    findings: all.map(stateFinding),
    autoRunCount:
      (previous.autoRunCount ?? 0) + (state.automatic === false ? 0 : 1),
    diffHash: state.reviewState?.diffHash,
  };
  let codeowners: string | undefined;
  if (config.review_suggest_reviewers) {
    const base = await client.getBranch(projectId, mr.target_branch);
    for (const location of [
      ".gitlab/CODEOWNERS",
      "CODEOWNERS",
      "docs/CODEOWNERS",
    ]) {
      try {
        codeowners = await client.getRepositoryFile(
          projectId,
          location,
          base.commit.id,
        );
        break;
      } catch (error) {
        if (!isMissingFile(error)) {
          warnCapability("CODEOWNERS suggestions", error);
          break;
        }
      }
    }
  }
  const summary = enrichReviewSummary(parsed.summary, {
    changedPaths,
    title: mr.title,
    description: mr.description ?? "",
    codeowners,
    suggestReviewers: config.review_suggest_reviewers,
    includeEffort: config.review_effort,
    preMergeChecks: config.review_pre_merge_checks,
    ignoredPaths: state.filesSkipped,
    security: {
      enabled:
        process.env.DROID_SECURITY_ONLY === "true" ||
        config.automatic_security_review,
      threshold: config.security_severity_threshold,
      blockOnCritical: config.security_block_on_critical,
      blockOnHigh: config.security_block_on_high,
    },
  });
  const renderInput: ReviewRenderInput = {
    ...renderOptions,
    state: open.length ? "findings" : "clean",
    findings: all,
    resolved,
    blocked,
    summary,
    depth: config.review_depth,
    model: state.resolvedModel ?? undefined,
    reasoning: state.resolvedReasoningEffort ?? undefined,
    base: mr.diff_refs.base_sha,
    jobUrl: state.jobUrl ?? undefined,
    reviewState,
    candidatesConsidered: parsed.approvedCount + parsed.rejectedCount,
    postedCount: result.posted + outside.length,
    dropped,
    skippedCount: parsed.skipped.length,
    showDroppedFindings: config.show_dropped_findings,
    diagram: config.review_diagram,
    sections: config.review_summary_sections,
    unchangedSuggestions: reconciled.unchangedSuggestions,
  };
  if (process.env.DROID_SECURITY_FULL === "true") {
    const noteId = Number(process.env.DROID_TRIGGER_NOTE_ID);
    if (!Number.isSafeInteger(noteId) || noteId <= 0)
      throw new Error(
        "Security report is missing its authenticated trigger note",
      );
    const reportUrl = await publishGitlabSecurityReport(
      client,
      projectId,
      mr,
      noteId,
      {
        ...renderInput,
        findings: scan?.review.findings ?? findings,
        securityReport: scan?.provenance,
      },
    );
    renderInput.summary = {
      ...summary,
      body: `${summary.body ?? ""} Full security report: ${reportUrl}`.trim(),
    };
  }

  const results: PostResults = {
    posted: result.posted,
    fallbackPosted: result.fallbackPosted,
    approved: parsed.approvedCount,
    rejected: parsed.rejectedCount,
    failed: result.failures.length,
    skipped: parsed.skipped.length,
    summaryBody: parsed.summaryBody,
    failures: result.failures,
    renderInput,
  };

  const resultsPath = postResultsFilePath();
  await fs.mkdir(path.dirname(resultsPath), { recursive: true });
  await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));
  console.log(
    `Posted ${results.posted}/${parsed.approved.length} inline comments ` +
      `(${results.fallbackPosted} as regular notes) on MR !${mrIid} ` +
      `(results: ${resultsPath}).`,
  );

  // Unanchorable comments already fell back to plain notes, so nothing at
  // all reaching the MR points at a systemic problem (revoked token scope,
  // API unreachable) rather than bad line numbers. Surface it.
  if (
    commentsToPost.length > 0 &&
    results.posted === 0 &&
    results.fallbackPosted === 0
  ) {
    throw new Error(
      `gitlab-post-review: all ${parsed.approved.length} approved comments failed to post. ` +
        `First error: ${results.failures[0]?.error ?? "unknown"}`,
    );
  }
}

if (import.meta.main) {
  run().catch((error) => {
    console.error("gitlab-post-review failed:", error);
    process.exit(1);
  });
}

export { run };
