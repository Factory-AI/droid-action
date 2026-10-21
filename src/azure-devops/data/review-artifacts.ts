/**
 * Writes the three review artifacts (diff, existing comments, description)
 * that the shared Pass-1 / Pass-2 prompts read from disk.
 *
 * Azure DevOps has no REST endpoint that returns a unified diff, so the
 * diff comes from the pipeline's own checkout (`fetchDepth: 0`), using the
 * merge base and source commit of the PR iteration being reviewed.
 */

import { writeReviewArtifacts } from "../../core/review/artifacts/write";
import type { ReviewArtifactPaths } from "../../core/review/artifacts/types";
import type { AdoIteration, AdoPullRequest, AdoThread } from "../types";
import { diffCommits, ensureCommit, mergeBase, type GitRunner } from "../git";

export type ExistingComment = {
  threadId: number;
  status: string | null;
  filePath: string | null;
  line: number | null;
  side: "LEFT" | "RIGHT" | null;
  comments: Array<{
    id: number;
    author: string | null;
    content: string;
    publishedDate: string | null;
  }>;
};

/** Drops deleted threads/comments and system notices (votes, pushes). */
export function flattenThreads(threads: AdoThread[]): ExistingComment[] {
  const out: ExistingComment[] = [];
  for (const thread of threads) {
    if (thread.isDeleted) continue;
    const comments = (thread.comments ?? [])
      .filter(
        (c) =>
          !c.isDeleted &&
          c.commentType !== "system" &&
          typeof c.content === "string" &&
          c.content.length > 0,
      )
      .map((c) => ({
        id: c.id,
        author: c.author?.displayName ?? c.author?.uniqueName ?? null,
        content: c.content!,
        publishedDate: c.publishedDate ?? null,
      }));
    if (comments.length === 0) continue;

    const ctx = thread.threadContext ?? null;
    const right = ctx?.rightFileEnd ?? ctx?.rightFileStart;
    const left = ctx?.leftFileEnd ?? ctx?.leftFileStart;
    out.push({
      threadId: thread.id,
      status: thread.status ?? null,
      filePath: ctx?.filePath ? ctx.filePath.replace(/^\//, "") : null,
      line: right?.line ?? left?.line ?? null,
      side: right ? "RIGHT" : left ? "LEFT" : null,
      comments,
    });
  }
  return out;
}

export function buildDescriptionContent(pr: AdoPullRequest): string {
  return `Title: ${pr.title ?? ""}\n\n${pr.description ?? ""}\n`;
}

/**
 * The iteration to review: the one whose source commit is the commit this
 * build was queued for. Without that commit (older Server versions do not
 * set it), the latest one.
 */
export function selectIteration(
  iterations: AdoIteration[],
  sourceCommitId: string | null,
): AdoIteration {
  if (iterations.length === 0) {
    throw new Error("Pull request has no iterations");
  }
  const sorted = [...iterations].sort((a, b) => a.id - b.id);
  if (sourceCommitId) {
    const match = sorted.find(
      (it) =>
        it.sourceRefCommit?.commitId?.toLowerCase() ===
        sourceCommitId.toLowerCase(),
    );
    if (match) return match;
    // Reviewing another iteration would post findings against a commit this
    // build did not check out.
    throw new Error(
      `No pull request iteration has source commit ${sourceCommitId} ` +
        `(latest is iteration ${sorted[sorted.length - 1]!.id}); re-queue the build.`,
    );
  }
  return sorted[sorted.length - 1]!;
}

/** Merge base and head for an iteration, verified to exist locally. */
export function resolveDiffRange(
  git: GitRunner,
  iteration: AdoIteration,
): { base: string; head: string } {
  const head = iteration.sourceRefCommit.commitId;
  ensureCommit(git, head);
  const common = iteration.commonRefCommit?.commitId;
  if (common) {
    ensureCommit(git, common);
    return { base: common, head };
  }
  const target = iteration.targetRefCommit.commitId;
  ensureCommit(git, target);
  return { base: mergeBase(git, target, head), head };
}

export async function writeAzureDevopsReviewArtifacts(opts: {
  git: GitRunner;
  pr: AdoPullRequest;
  threads: AdoThread[];
  range: { base: string; head: string };
  outDir: string;
}): Promise<ReviewArtifactPaths> {
  return writeReviewArtifacts(
    opts.outDir,
    {
      diff: diffCommits(opts.git, opts.range.base, opts.range.head),
      comments: flattenThreads(opts.threads),
      description: buildDescriptionContent(opts.pr),
    },
    {
      diff: "pr.diff",
      comments: "existing_comments.json",
      description: "pr_description.txt",
    },
  );
}
