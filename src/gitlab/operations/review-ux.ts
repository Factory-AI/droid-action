import { GitlabApiError, type GitlabClient } from "../api/client";
import type { GitlabDiscussion, GitlabMr } from "../types";
import {
  findReviewSummaryRange,
  decodeFindingMarker,
  decodeReviewState,
  type ReviewState,
  type ReviewStateFinding,
} from "../../core/review/markers";
import {
  renderCheckRun,
  renderReviewSummary,
  renderReviewStateNote,
  ReviewOutputBudgetError,
  type ReviewRenderInput,
} from "../../core/review/render";
import type { ReviewFinding } from "../../core/review/validated/types";
import { normalizeFinding } from "../../core/review/validated/finding";
import { findOwnTrackingNote } from "./post-target";

const warned = new Set<string>();
export function warnCapability(capability: string, error: unknown): void {
  if (warned.has(capability)) return;
  warned.add(capability);
  console.warn(
    `GitLab ${capability} unavailable; review continues. ${error instanceof Error ? error.message : String(error)}`,
  );
}

export function hasGitlabWriteAccess(member: {
  access_level: number;
  expires_at?: string | null;
}): boolean {
  return (
    member.access_level >= 30 &&
    (!member.expires_at ||
      member.expires_at >= new Date().toISOString().slice(0, 10))
  );
}

export async function loadReviewMemory(
  client: GitlabClient,
  projectId: string | number,
  mrIid: number,
) {
  const [user, notes] = await Promise.all([
    client.getCurrentUser(),
    client.listNotes(projectId, mrIid),
  ]);
  const note = findOwnTrackingNote(notes, user.id);
  return { user, note, state: note ? decodeReviewState(note.body) : null };
}

export function discussionFinding(
  discussion: GitlabDiscussion,
  userId: number,
) {
  const note = discussion.notes.find(
    (note) => note.author?.id === userId && decodeFindingMarker(note.body),
  );
  if (!note) return null;
  return { note, marker: decodeFindingMarker(note.body)! };
}

export function reconcileDiscussionState(
  state: ReviewState,
  discussions: GitlabDiscussion[],
  userId: number,
): ReviewState {
  return {
    ...state,
    findings: state.findings.map((finding) => {
      if (finding.state !== "open") return { ...finding };
      const discussion = discussions.find(
        (d) => d.id === (finding.threadId ?? finding.thread),
      );
      const own = discussion && discussionFinding(discussion, userId);
      // A human-resolved discussion is a dismissal, never evidence of a fix.
      if (own?.note.resolved) return { ...finding, state: "dismissed" };
      return { ...finding };
    }),
  };
}

export function findingFromState(entry: ReviewStateFinding): ReviewFinding {
  const threadId = entry.threadId ?? entry.thread;
  const finding =
    entry.finding ??
    normalizeFinding({
      id: entry.id,
      severity: entry.sev,
      title: entry.title ?? entry.id,
      path: entry.path ?? "",
      line: entry.line,
      body: entry.body ?? entry.title ?? entry.id,
    });
  return {
    ...finding,
    state: entry.state,
    isNew: false,
    ...(typeof threadId === "string" ? { threadId } : {}),
    ...(entry.url ? { threadUrl: entry.url } : {}),
  };
}

export function stateFinding(finding: ReviewFinding): ReviewStateFinding {
  return {
    id: finding.id,
    sev: finding.severity,
    state: finding.state ?? "open",
    path: finding.path,
    ...(finding.line ? { line: finding.line } : {}),
    title: finding.title,
    body: finding.body,
    ...(typeof finding.threadId === "string"
      ? { threadId: finding.threadId, thread: finding.threadId }
      : {}),
    ...(finding.threadUrl ? { url: finding.threadUrl } : {}),
    finding,
  };
}

export function renderGitlabSummary(input: ReviewRenderInput): string {
  try {
    return renderReviewSummary({ ...input, platform: "gitlab" });
  } catch (error) {
    if (!(error instanceof ReviewOutputBudgetError)) throw error;
    return renderReviewSummary({
      platform: "gitlab",
      state: "failed",
      head: input.head,
      jobUrl: input.jobUrl,
      error:
        "The review output is too large to post safely. Reduce the review scope or summary sections, then retry.",
      ...(input.reviewState
        ? {
            reviewState: {
              ...input.reviewState,
              findings: input.reviewState.findings.map(
                ({ finding: _finding, body: _body, ...finding }) => finding,
              ),
            },
          }
        : {}),
    });
  }
}

export function descriptionWithReview(
  description: string,
  body: string,
): string {
  const start = "<!-- droid-review-description:start -->";
  const end = "<!-- droid-review-description:end -->";
  const block = `${start}\n${body}\n${end}`;
  const range = findReviewSummaryRange(description, "gitlab");
  if (range)
    return (
      description.slice(0, range.start) + block + description.slice(range.end)
    );
  return description ? `${description}\n\n${block}` : block;
}

/** The hidden state note remains even when visible summaries are disabled. */
export function stateOnlyNote(input: ReviewRenderInput): string {
  return renderReviewStateNote(input.reviewState);
}

export async function updateReviewStatus(
  client: GitlabClient,
  projectId: string | number,
  sha: string,
  input: ReviewRenderInput,
  enabled = true,
  phase?: "queued" | "in_progress",
): Promise<void> {
  if (!enabled || !sha) return;
  const rendered = renderCheckRun({ ...input, phase: phase ?? "completed" });
  // Commit statuses have no neutral result or markdown text. Nonblocking
  // findings/errors are successful statuses; the sticky note carries detail.
  const state =
    phase === "queued"
      ? "pending"
      : phase === "in_progress"
        ? "running"
        : input.blocked
          ? "failed"
          : input.state === "skipped"
            ? "skipped"
            : "success";
  try {
    await client.setCommitStatus(projectId, sha, {
      state,
      name: "Droid Review",
      description: rendered.title.slice(0, 255),
      ...(input.jobUrl ? { target_url: input.jobUrl } : {}),
    });
  } catch (error) {
    warnCapability("commit status", error);
  }
}

export type LifecycleAwardContext = {
  projectId: string;
  mrIid: number;
  id: number;
};

export async function updateLifecycleAward(
  client: GitlabClient,
  projectId: string | number,
  mrIid: number,
  phase: "running" | "clean" | "failed" | "done",
  enabled = true,
  knownOwnAward?: LifecycleAwardContext | null,
): Promise<LifecycleAwardContext | null> {
  if (!enabled) return null;
  try {
    // Never enumerate reactions, including human thumbs. The parent shell
    // carries only the actual ID returned by our pre-model award creation.
    if (
      knownOwnAward &&
      knownOwnAward.projectId === String(projectId) &&
      knownOwnAward.mrIid === mrIid &&
      Number.isSafeInteger(knownOwnAward.id) &&
      knownOwnAward.id > 0
    )
      await client.removeAward(projectId, mrIid, knownOwnAward.id);
    const target =
      phase === "running"
        ? "eyes"
        : phase === "clean"
          ? "tada"
          : phase === "failed"
            ? "confused"
            : null;
    if (!target) return null;
    const award = await client.addAward(projectId, mrIid, target);
    return Number.isSafeInteger(award.id) && award.id > 0
      ? { projectId: String(projectId), mrIid, id: award.id }
      : null;
  } catch (error) {
    warnCapability("lifecycle award emoji", error);
    return null;
  }
}

export async function resolveFixedDiscussions(options: {
  client: GitlabClient;
  projectId: string | number;
  mr: GitlabMr;
  state: ReviewState;
  discussions: GitlabDiscussion[];
  userId: number;
  fixed: Array<{ id: string; evidence: string }>;
  changedPaths: string[];
  enabled: boolean;
}): Promise<{ state: ReviewState; resolved: ReviewFinding[] }> {
  const { client, projectId, mr, discussions, userId } = options;
  const state = reconcileDiscussionState(options.state, discussions, userId);
  const resolved: ReviewFinding[] = [];
  for (const finding of state.findings) {
    if (
      !options.enabled ||
      finding.state !== "open" ||
      !finding.path ||
      !options.changedPaths.includes(finding.path)
    )
      continue;
    if (
      !options.fixed.some(
        (fixed) => fixed.id === finding.id && fixed.evidence.trim(),
      )
    )
      continue;
    const discussion = discussions.find(
      (d) => d.id === (finding.threadId ?? finding.thread),
    );
    const own = discussion && discussionFinding(discussion, userId);
    if (
      !discussion ||
      own?.marker.id !== finding.id ||
      !own.note.resolvable ||
      own.note.resolved
    )
      continue;
    try {
      await client.replyToDiscussion(
        projectId,
        mr.iid,
        discussion.id,
        `✅ Fixed in ${mr.diff_refs.head_sha.slice(0, 7)}.`,
      );
      await client.resolveDiscussion(projectId, mr.iid, discussion.id);
      finding.state = "resolved";
      resolved.push({
        ...findingFromState(finding),
        state: "resolved",
        fixedIn: mr.diff_refs.head_sha,
      });
    } catch (error) {
      warnCapability("discussion auto-resolution", error);
    }
  }
  return { state, resolved };
}

export function isMissingFile(error: unknown): boolean {
  return error instanceof GitlabApiError && error.status === 404;
}
