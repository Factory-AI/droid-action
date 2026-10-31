import * as fs from "fs/promises";
import * as path from "path";
import { execFileSync } from "child_process";
import * as core from "@actions/core";
import { createOctokit, type Octokits } from "../api/client";
import type { ParsedGitHubContext } from "../context";
import { DROID_APP_BOT_ID } from "../bot-identity";
import { GITHUB_SERVER_URL } from "../api/config";
import {
  decodeFindingMarker,
  decodeReviewState,
  encodeReviewState,
  findReviewSummaryRange,
  hasSummaryMarker,
  SUMMARY_MARKER,
  hasReviewSessionMarker,
  stripReviewSessionMarkers,
  type ReviewState,
} from "../../core/review/markers";
import { planIncrementalReview } from "../../core/review/incremental";
import {
  renderCheckRun,
  renderReviewSummary,
  renderReviewStateNote,
  renderStepSummary,
} from "../../core/review/render";
import type {
  CheckRunInput,
  ReviewRenderInput,
} from "../../core/review/render/types";
import type { ReviewFinding } from "../../core/review/validated/types";
import { normalizeFinding } from "../../core/review/validated/finding";
import { redactCredentials } from "../../utils/redact-credentials";
import {
  createReviewCheck,
  optionalGitHubOperation,
  reviewCheckConclusion,
  reviewCheckExternalId,
  updateReviewCheck,
} from "./review-checks";
import { reviewConfigFromEnvironment } from "../../core/review/config";
import { fitReviewOutput } from "../../core/review/render/budget";
import { isManualReviewRequest } from "../utils/review-intent";
import { retryWithBackoff } from "../../utils/retry";
import { isPermissionError } from "./review-checks";

export type DroidReviewThread = {
  nodeId: string;
  commentId: number;
  body: string;
  path: string;
  line: number | null;
  side?: "LEFT" | "RIGHT";
  startLine?: number | null;
  resolved: boolean;
  url: string;
  findingId: string;
  comments: Array<{ id: number; body: string }>;
};
export type ReviewLifecycleRun = {
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  head: string;
  runId?: string;
  runAttempt?: string;
  base?: string;
  state: ReviewState;
  previousBody?: string;
  automatic: boolean;
  securityOnly: boolean;
  startedAt: string;
  checkId?: number;
  warned?: boolean;
  skipReason?: string;
  incrementalBaseSha?: string;
  eligibleFixedIds?: string[];
  reaction?: {
    id: number;
    targetId: number;
    kind: "issue" | "issue_comment" | "review_comment";
  };
  steps: NonNullable<CheckRunInput["steps"]>;
  renderInput?: ReviewRenderInput;
  completed?: boolean;
  superseded?: boolean;
  pullRequest?: { title: string; body: string; baseSha: string };
  previousState?: ReviewState;
  full?: boolean;
};

export type ReviewSessionIdentity = Readonly<{
  runId: string;
  runAttempt?: string;
}>;

function validatedRunAttempt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error("Invalid trusted workflow run attempt.");
  return value;
}

export function reviewLifecycleFilePath(): string {
  return (
    process.env.REVIEW_LIFECYCLE_PATH ||
    path.join(
      process.env.RUNNER_TEMP || "/tmp",
      "droid-prompts",
      "review_lifecycle.json",
    )
  );
}
export async function saveReviewLifecycle(
  run: ReviewLifecycleRun,
): Promise<void> {
  const file = reviewLifecycleFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, redactCredentials(JSON.stringify(run, null, 2)));
}
export async function readReviewLifecycle(): Promise<ReviewLifecycleRun | null> {
  try {
    return JSON.parse(await fs.readFile(reviewLifecycleFilePath(), "utf8"));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  }
}
export function authoritativeReviewTarget(
  env: NodeJS.ProcessEnv = process.env,
): { owner: string; repo: string; prNumber: number; head: string } {
  const owner = env.REPO_OWNER;
  const repo = env.REPO_NAME;
  const prNumber = Number(env.PR_NUMBER);
  const head = env.REVIEW_HEAD_SHA;
  if (
    !owner ||
    !repo ||
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !head ||
    !/^[a-f0-9]{7,64}$/i.test(head)
  ) {
    throw new Error(
      "Immutable review target outputs are missing or invalid; refusing to mutate review metadata.",
    );
  }
  return { owner, repo, prNumber, head };
}
/** The local file is a cache, never authority to choose API targets or thread dispositions. */
export async function loadBoundReviewLifecycle(
  octokit: Octokits,
  reviewSession?: ReviewSessionIdentity,
): Promise<ReviewLifecycleRun | null> {
  const runId = reviewSession?.runId ?? process.env.GITHUB_RUN_ID;
  const runAttempt = validatedRunAttempt(
    reviewSession?.runAttempt || process.env.GITHUB_RUN_ATTEMPT,
  );
  const expectedCheckExternalId = reviewCheckExternalId(
    runId || "",
    runAttempt || "1",
  );
  let cached: ReviewLifecycleRun | null;
  try {
    cached = await readReviewLifecycle();
  } catch {
    cached = null;
  }
  if (!cached && !process.env.REVIEW_HEAD_SHA) return null;
  const target = authoritativeReviewTarget();
  if (
    cached &&
    (cached.owner !== target.owner ||
      cached.repo !== target.repo ||
      cached.prNumber !== target.prNumber ||
      cached.head !== target.head)
  )
    throw new Error(
      "Review lifecycle target disagrees with immutable preparation outputs; refusing to post.",
    );
  const run: ReviewLifecycleRun = {
    ...cached,
    ...target,
    runId,
    runAttempt,
    commentId: 0,
    checkId: undefined,
    reaction: undefined,
    state: { head: "", findings: [] },
    completed: false,
    base: process.env.REVIEW_BASE_SHA,
    startedAt: process.env.REVIEW_STARTED_AT || new Date().toISOString(),
    incrementalBaseSha: process.env.REVIEW_INCREMENTAL_BASE_SHA || undefined,
    automatic: process.env.REVIEW_AUTOMATIC === "true",
    securityOnly: process.env.REVIEW_SECURITY_ONLY === "true",
    renderInput: undefined,
    eligibleFixedIds: undefined,
    skipReason: undefined,
    superseded: false,
    previousState: undefined,
    pullRequest: undefined,
    full: undefined,
    steps: Array.isArray(cached?.steps)
      ? cached.steps
          .filter(
            (step) =>
              step &&
              typeof step.name === "string" &&
              ["pending", "running", "completed", "failed"].includes(
                step.status,
              ),
          )
          .slice(0, 20)
      : [],
  };
  const warn = lifecycleWarning(run);
  const commentId = Number(process.env.REVIEW_COMMENT_ID);
  if (Number.isSafeInteger(commentId) && commentId > 0) {
    const comment = await optionalGitHubOperation(
      () =>
        octokit.rest.issues.getComment({
          owner: target.owner,
          repo: target.repo,
          comment_id: commentId,
        }),
      warn,
    );
    const viewer = await viewerLogin(octokit);
    if (
      comment &&
      (!trustedAuthor(comment.data.user, viewer) ||
        !hasSummaryMarker(comment.data.body || "") ||
        !comment.data.issue_url.endsWith(`/issues/${target.prNumber}`))
    )
      throw new Error(
        "The prepared summary is not an owned review comment on this PR.",
      );
    if (comment) {
      run.commentId = commentId;
      run.state = decodeReviewState(comment.data.body || "") ?? {
        head: "",
        findings: [],
      };
      run.previousState = run.state;
      run.previousBody = comment.data.body
        ? stripReviewSessionMarkers(comment.data.body)
        : undefined;
      if (
        reviewConfigFromEnvironment().review_summary !== "off" &&
        !hasSession(comment.data.body || "", run, "active")
      ) {
        run.completed = hasSession(comment.data.body || "", run, "completed");
        run.superseded = !run.completed;
      }
    }
  }
  const checkId = Number(process.env.REVIEW_CHECK_ID);
  if (
    Number.isSafeInteger(checkId) &&
    checkId > 0 &&
    reviewConfigFromEnvironment().review_check_run
  ) {
    // A shared summary is not evidence that this run's check has finished.
    if (run.completed) run.superseded = true;
    run.completed = false;
    const check = await optionalGitHubOperation(
      () =>
        checkClient(octokit).rest.checks.get({
          owner: target.owner,
          repo: target.repo,
          check_run_id: checkId,
        }),
      warn,
    );
    if (
      check &&
      (check.data.head_sha !== target.head ||
        !expectedCheckExternalId ||
        check.data.external_id !== expectedCheckExternalId ||
        !["Droid Review", "Droid Security Review"].includes(check.data.name))
    )
      throw new Error(
        "The prepared check run does not belong to this reviewed commit.",
      );
    if (check) {
      run.checkId = checkId;
      run.securityOnly = check.data.name === "Droid Security Review";
      run.completed = check.data.status === "completed";
    }
  }
  const reactionId = Number(process.env.REVIEW_REACTION_ID);
  const reactionTarget = Number(process.env.REVIEW_REACTION_TARGET);
  const reactionKind = process.env.REVIEW_REACTION_KIND;
  if (
    Number.isSafeInteger(reactionId) &&
    reactionId > 0 &&
    Number.isSafeInteger(reactionTarget) &&
    reactionTarget > 0 &&
    (reactionKind === "issue" ||
      reactionKind === "issue_comment" ||
      reactionKind === "review_comment")
  )
    run.reaction = {
      id: reactionId,
      targetId: reactionTarget,
      kind: reactionKind,
    };
  const pr = await optionalGitHubOperation(
    () =>
      octokit.rest.pulls.get({
        owner: target.owner,
        repo: target.repo,
        pull_number: target.prNumber,
      }),
    warn,
  );
  if (pr) {
    if (pr.data.head.sha !== target.head) run.superseded = true;
    run.pullRequest = {
      title: pr.data.title,
      body: pr.data.body || "",
      baseSha: pr.data.base.sha,
    };
  } else run.pullRequest = undefined;
  if (run.incrementalBaseSha !== run.state.head)
    run.incrementalBaseSha = undefined;
  return run;
}
/** Fetch a diff between immutable commits, never trust the model-writable on-disk artifact for resolution decisions. */
export async function fetchImmutableReviewDiff(
  octokit: Octokits,
  target: {
    owner: string;
    repo: string;
    base: string;
    head: string;
    direct?: boolean;
  },
): Promise<string> {
  if (
    !/^[a-f0-9]{7,64}$/i.test(target.base) ||
    !/^[a-f0-9]{7,64}$/i.test(target.head)
  )
    throw new Error("Review diff requires immutable base and head SHAs.");
  if (target.direct) {
    try {
      return execFileSync(
        "git",
        [
          "--no-replace-objects",
          "--no-pager",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          `${target.base}..${target.head}`,
        ],
        {
          encoding: "utf8",
          maxBuffer: 50 * 1024 * 1024,
          stdio: "pipe",
        },
      );
    } catch {
      // GitHub's comparison diff is three-dot. It is equivalent to the
      // required previous-tree diff only when the previous head is an ancestor.
      const comparison = await octokit.rest.repos.compareCommitsWithBasehead({
        owner: target.owner,
        repo: target.repo,
        basehead: `${target.base}...${target.head}`,
      });
      if (comparison.data.merge_base_commit?.sha !== target.base)
        throw new Error(
          "The previous reviewed tree is unavailable; refusing three-dot fixed eligibility.",
        );
    }
  }
  const response = await octokit.rest.repos.compareCommitsWithBasehead({
    owner: target.owner,
    repo: target.repo,
    basehead: `${target.base}...${target.head}`,
    mediaType: { format: "diff" },
  });
  const diff: unknown = response.data;
  if (typeof diff !== "string")
    throw new Error("GitHub did not return an immutable review diff.");
  return diff;
}
export function lifecycleWarning(
  run: ReviewLifecycleRun,
): (message: string) => void {
  return (message) => {
    if (!run.warned) {
      run.warned = true;
      core.warning(message);
    }
  };
}
function checkClient(octokit: Octokits): Octokits {
  return process.env.WORKFLOW_GITHUB_TOKEN
    ? createOctokit(process.env.WORKFLOW_GITHUB_TOKEN)
    : octokit;
}
type CommentAuthor = { id?: number; login?: string } | null | undefined;
function trustedAuthor(author: CommentAuthor, viewer?: string): boolean {
  return (
    author?.id === DROID_APP_BOT_ID ||
    (!!author?.login &&
      author.login === (process.env.DROID_BOT_LOGIN || viewer))
  );
}
export async function viewerLogin(
  octokit: Octokits,
): Promise<string | undefined> {
  try {
    const result = await octokit.graphql<{ viewer: { login: string } }>(
      "query DroidViewer { viewer { login } }",
    );
    return result.viewer.login;
  } catch {
    return undefined;
  }
}
function sessionMarker(
  run: ReviewLifecycleRun,
  state: "active" | "completed",
): string {
  return `<!-- droid-review-${state}:v1 head=${run.head} run=${run.runId}${run.runAttempt ? ` attempt=${run.runAttempt}` : ""} -->`;
}
function hasSession(
  body: string,
  run: ReviewLifecycleRun,
  state: "active" | "completed",
): boolean {
  // A legacy marker can only authenticate the first (or unknown legacy) attempt.
  return (
    hasReviewSessionMarker(body, sessionMarker(run, state)) ||
    (run.runAttempt === "1" &&
      hasReviewSessionMarker(
        body,
        sessionMarker({ ...run, runAttempt: undefined }, state),
      ))
  );
}
/** Revalidate within each write attempt. GitHub offers no atomic comment CAS. */
async function ownsReviewSummary(
  octokit: Octokits,
  run: ReviewLifecycleRun,
  allowCompleted = false,
): Promise<boolean> {
  if (run.superseded || !run.commentId || !run.runId) return false;
  const viewer = await viewerLogin(octokit);
  const pr = await octokit.rest.pulls.get({
    owner: run.owner,
    repo: run.repo,
    pull_number: run.prNumber,
  });
  run.pullRequest = {
    title: pr.data.title,
    body: pr.data.body || "",
    baseSha: pr.data.base.sha,
  };
  const comment = await octokit.rest.issues.getComment({
    owner: run.owner,
    repo: run.repo,
    comment_id: run.commentId,
  });
  const body = comment.data.body || "";
  const owned =
    pr.data.head.sha === run.head &&
    trustedAuthor(comment.data.user, viewer) &&
    comment.data.issue_url.endsWith(`/issues/${run.prNumber}`) &&
    hasSummaryMarker(body) &&
    (hasSession(body, run, "active") ||
      (allowCompleted && hasSession(body, run, "completed")));
  if (!owned) run.superseded = true;
  return owned;
}
export async function findReviewSummary(options: {
  octokit: Octokits;
  owner: string;
  repo: string;
  prNumber: number;
}) {
  const viewer = await viewerLogin(options.octokit);
  for (let page = 1; ; page++) {
    const response = await retryWithBackoff(
      () =>
        options.octokit.rest.issues.listComments({
          owner: options.owner,
          repo: options.repo,
          issue_number: options.prNumber,
          per_page: 100,
          page,
        }),
      {
        initialDelayMs: 250,
        maxDelayMs: 1000,
        shouldRetry: (error) => !isPermissionError(error),
      },
    );
    const comment = response.data.find(
      (comment) =>
        trustedAuthor(comment.user, viewer) &&
        hasSummaryMarker(comment.body || ""),
    );
    if (comment || response.data.length < 100) return comment;
  }
}
export async function listDroidThreads(options: {
  octokit: Octokits;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<DroidReviewThread[]> {
  const viewer = await viewerLogin(options.octokit);
  type ThreadNode = {
    id: string;
    isResolved: boolean;
    path: string;
    line: number | null;
    diffSide?: "LEFT" | "RIGHT";
    startLine?: number | null;
    comments: {
      pageInfo?: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        databaseId: number;
        body: string;
        url: string;
        author: { login: string; databaseId?: number } | null;
      }>;
    };
  };
  const threads: DroidReviewThread[] = [];
  let cursor: string | null = null;
  do {
    const result: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: ThreadNode[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        };
      };
    } = await options.octokit.graphql(
      `query DroidReviewThreads($owner:String!,$repo:String!,$number:Int!,$cursor:String) {
        repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
          reviewThreads(first:100,after:$cursor) { nodes { id isResolved path line diffSide startLine comments(first:100) {
            nodes { databaseId body url author { login ... on User { databaseId } ... on Bot { databaseId } } }
            pageInfo { hasNextPage endCursor }
          } } pageInfo { hasNextPage endCursor } }
        } }
      }`,
      {
        owner: options.owner,
        repo: options.repo,
        number: options.prNumber,
        cursor,
      },
    );
    const page = result.repository.pullRequest.reviewThreads;
    for (const node of page.nodes) {
      const root = node.comments.nodes[0];
      if (
        !root ||
        !trustedAuthor(
          root.author
            ? { id: root.author.databaseId, login: root.author.login }
            : null,
          viewer,
        )
      )
        continue;
      const marker = decodeFindingMarker(root.body);
      if (!marker) continue;
      const comments = node.comments.nodes.map((comment) => ({
        id: comment.databaseId,
        body: comment.body,
      }));
      let commentPage = node.comments.pageInfo;
      const seenCursors = new Set<string>();
      while (commentPage?.hasNextPage) {
        const after = commentPage.endCursor;
        if (!after || seenCursors.has(after))
          throw new Error(
            "GitHub did not provide a new review-comment page cursor.",
          );
        seenCursors.add(after);
        const next = await options.octokit.graphql<{
          node: {
            comments: {
              nodes: Array<{ databaseId: number; body: string }>;
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        }>(
          `query DroidReviewThreadComments($id:ID!,$cursor:String!) {
            node(id:$id) { ... on PullRequestReviewThread { comments(first:100,after:$cursor) {
              nodes { databaseId body } pageInfo { hasNextPage endCursor }
            } } }
          }`,
          { id: node.id, cursor: after },
        );
        comments.push(
          ...next.node.comments.nodes.map((comment) => ({
            id: comment.databaseId,
            body: comment.body,
          })),
        );
        commentPage = next.node.comments.pageInfo;
      }
      threads.push({
        nodeId: node.id,
        commentId: root.databaseId,
        body: root.body,
        path: node.path,
        line: node.line,
        side: node.diffSide,
        startLine: node.startLine,
        resolved: node.isResolved,
        url: root.url,
        findingId: marker.id,
        comments,
      });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return threads;
}
export async function resolveDroidThread(options: {
  octokit: Octokits;
  owner: string;
  repo: string;
  prNumber: number;
  thread: DroidReviewThread;
  head?: string;
  reply?: boolean;
}): Promise<void> {
  if (options.thread.resolved) return;
  const reply =
    options.reply !== false && options.head
      ? `✅ Fixed in ${options.head.slice(0, 7)}.`
      : undefined;
  if (
    reply &&
    !options.thread.comments.some((comment) => comment.body === reply)
  ) {
    const response =
      await options.octokit.rest.pulls.createReplyForReviewComment({
        owner: options.owner,
        repo: options.repo,
        pull_number: options.prNumber,
        comment_id: options.thread.commentId,
        body: reply,
      });
    options.thread.comments.push({ id: response.data.id, body: reply });
  }
  const result = await options.octokit.graphql<{
    resolveReviewThread: { thread: { isResolved: boolean } };
  }>(
    "mutation DroidResolveThread($id:ID!) { resolveReviewThread(input:{threadId:$id}) { thread { id isResolved } } }",
    { id: options.thread.nodeId },
  );
  if (result.resolveReviewThread?.thread?.isResolved !== true)
    throw new Error("GitHub did not confirm thread resolution.");
  options.thread.resolved = true;
}
export async function reopenDroidThread(options: {
  octokit: Octokits;
  thread: DroidReviewThread;
}): Promise<void> {
  if (!options.thread.resolved) return;
  const result = await options.octokit.graphql<{
    unresolveReviewThread: { thread: { isResolved: boolean } };
  }>(
    "mutation DroidReopenThread($id:ID!) { unresolveReviewThread(input:{threadId:$id}) { thread { id isResolved } } }",
    { id: options.thread.nodeId },
  );
  if (result.unresolveReviewThread?.thread?.isResolved !== false)
    throw new Error("GitHub did not confirm thread reopening.");
  options.thread.resolved = false;
}
export async function resolveAllDroidThreads(options: {
  octokit: Octokits;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<number> {
  const threads = await listDroidThreads(options);
  let resolved = 0;
  for (const thread of threads.filter((t) => !t.resolved)) {
    await resolveDroidThread({ ...options, thread });
    resolved++;
  }
  const summary = await findReviewSummary(options);
  if (summary?.body) {
    const state = decodeReviewState(summary.body);
    if (state) {
      state.findings = state.findings.map((finding) => ({
        ...finding,
        state: "dismissed",
      }));
      await options.octokit.rest.issues.updateComment({
        owner: options.owner,
        repo: options.repo,
        comment_id: summary.id,
        body: replaceState(summary.body, state),
      });
    }
  }
  return resolved;
}
function replaceState(body: string, state: ReviewState): string {
  return `${body.replace(/<!--\s*droid-review-state:v1[\s\S]*?-->/g, "").trim()}\n\n${encodeReviewState(state)}`;
}
export async function setReviewPaused(options: {
  octokit: Octokits;
  owner: string;
  repo: string;
  prNumber: number;
  paused: boolean;
}): Promise<void> {
  const comment = await findReviewSummary(options);
  const state = decodeReviewState(comment?.body || "") ?? {
    head: "",
    findings: [],
  };
  state.paused = options.paused;
  if (!options.paused) state.autoRunCount = 0;
  const body = replaceState(comment?.body || SUMMARY_MARKER, state);
  if (comment)
    await options.octokit.rest.issues.updateComment({
      owner: options.owner,
      repo: options.repo,
      comment_id: comment.id,
      body,
    });
  else
    await options.octokit.rest.issues.createComment({
      owner: options.owner,
      repo: options.repo,
      issue_number: options.prNumber,
      body,
    });
}
async function createEyes(
  octokit: Octokits,
  context: ParsedGitHubContext,
  run: ReviewLifecycleRun,
  enabled: boolean,
): Promise<void> {
  if (!enabled) return;
  const target =
    "comment" in context.payload
      ? context.payload.comment.id
      : context.entityNumber;
  const kind =
    context.eventName === "pull_request_review_comment"
      ? "review_comment"
      : context.eventName === "issue_comment"
        ? "issue_comment"
        : "issue";
  const response = await optionalGitHubOperation(
    () =>
      kind === "review_comment"
        ? octokit.rest.reactions.createForPullRequestReviewComment({
            owner: run.owner,
            repo: run.repo,
            comment_id: target,
            content: "eyes",
          })
        : kind === "issue_comment"
          ? octokit.rest.reactions.createForIssueComment({
              owner: run.owner,
              repo: run.repo,
              comment_id: target,
              content: "eyes",
            })
          : octokit.rest.reactions.createForIssue({
              owner: run.owner,
              repo: run.repo,
              issue_number: target,
              content: "eyes",
            }),
    lifecycleWarning(run),
  );
  // 200 means the token user already had this shared reaction, not a new run-owned award.
  if (response?.status === 201)
    run.reaction = { id: response.data.id, kind, targetId: target };
}
export async function prepareReviewLifecycle(options: {
  octokit: Octokits;
  context: ParsedGitHubContext;
  headSha: string;
  runAttempt?: string;
  baseSha?: string;
  securityOnly?: boolean;
  full?: boolean;
  trackingCommentId?: number;
  skipReason?: string | null;
}): Promise<{
  commentId: number;
  state: ReviewState;
  incrementalBaseSha?: string;
  skipReason?: string;
  run: ReviewLifecycleRun;
}> {
  // Capture before any awaited operation, never recover identity from the cache.
  const runAttempt = validatedRunAttempt(
    options.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT,
  );
  const { owner, repo } = options.context.repository;
  let existing;
  let lookupFailed = false;
  try {
    existing = await findReviewSummary({
      octokit: options.octokit,
      owner,
      repo,
      prNumber: options.context.entityNumber,
    });
  } catch {
    lookupFailed = true;
  }
  const state = decodeReviewState(existing?.body || "") ?? {
    head: "",
    findings: [],
  };
  const config =
    options.context.inputs.reviewConfig ?? reviewConfigFromEnvironment();
  const automatic = !isManualReviewRequest(
    options.context,
    options.securityOnly ? "security" : "code",
  );
  const plan = planIncrementalReview({
    state,
    head: options.headSha,
    full: options.full,
    automatic,
    incremental: config.review_incremental,
    maxAutoRuns: config.review_max_auto_runs,
  });
  const run: ReviewLifecycleRun = {
    owner,
    repo,
    prNumber: options.context.entityNumber,
    commentId: existing?.id || options.trackingCommentId || 0,
    head: options.headSha,
    runId: options.context.runId,
    runAttempt,
    base: options.baseSha || process.env.REVIEW_BASE_SHA,
    state,
    previousBody: existing?.body
      ? stripReviewSessionMarkers(existing.body)
      : undefined,
    automatic,
    securityOnly: !!options.securityOnly,
    full: options.full,
    startedAt: new Date().toISOString(),
    steps: [],
    ...plan,
    ...(options.skipReason ? { skipReason: options.skipReason } : {}),
  };
  const warn = lifecycleWarning(run);
  if (lookupFailed)
    warn(
      "Droid could not read review metadata. Check pull-requests: write permissions; this review will continue without incremental memory.",
    );
  const jobUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${options.context.runId}`;
  run.checkId = await createReviewCheck({
    octokit: checkClient(options.octokit),
    owner,
    repo,
    head: run.head,
    runId: run.runId,
    runAttempt: run.runAttempt || "1",
    securityOnly: run.securityOnly,
    enabled: config.review_check_run,
    jobUrl,
    warn,
  });
  await createEyes(
    options.octokit,
    options.context,
    run,
    config.review_reactions && config.review_summary !== "off",
  );
  const input: ReviewRenderInput = {
    state: run.skipReason ? "skipped" : "in_progress",
    head: run.head,
    base: run.base,
    jobUrl,
    depth: config.review_depth,
    startedAt: run.startedAt,
    previousBody: run.previousBody,
    previousHead: state.head,
    reviewState: state,
    skipReason: run.skipReason,
  };
  const rendered = renderReviewSummary(input);
  const body = `${config.review_summary === "description" ? renderReviewStateNote(state) : rendered}\n\n${sessionMarker(run, "active")}`;
  const response =
    config.review_summary === "off"
      ? undefined
      : await optionalGitHubOperation<{ data: { id: number } }>(
          () =>
            run.commentId
              ? options.octokit.rest.issues.updateComment({
                  owner,
                  repo,
                  comment_id: run.commentId,
                  body,
                })
              : options.octokit.rest.issues.createComment({
                  owner,
                  repo,
                  issue_number: run.prNumber,
                  body,
                }),
          warn,
        );
  if (response) run.commentId = response.data.id;
  if (config.review_summary === "description")
    await publishDescriptionSummary(options.octokit, run, input);
  for (const [key, value] of Object.entries({
    repo_owner: owner,
    repo_name: repo,
    pr_number: run.prNumber,
    review_head_sha: run.head,
    review_base_sha: run.base || "",
    review_comment_id: run.commentId,
    review_check_id: run.checkId || "",
    review_started_at: run.startedAt,
    review_incremental_base_sha: run.incrementalBaseSha || "",
    review_reaction_id: run.reaction?.id || "",
    review_reaction_target: run.reaction?.targetId || "",
    review_reaction_kind: run.reaction?.kind || "",
    review_automatic: String(run.automatic),
    review_security_only: String(run.securityOnly),
    review_skipped: String(!!run.skipReason),
  }))
    core.setOutput(key, value);
  await saveReviewLifecycle(run);
  if (run.skipReason)
    await finishReviewLifecycle({ octokit: options.octokit, run, input });
  else
    await advanceReviewLifecycle({
      octokit: options.octokit,
      run,
      name: "Gathering PR context",
    });
  return {
    commentId: run.commentId,
    state,
    incrementalBaseSha: run.incrementalBaseSha,
    skipReason: run.skipReason,
    run,
  };
}
export async function advanceReviewLifecycle(options: {
  octokit: Octokits;
  run?: ReviewLifecycleRun;
  name: string;
  completedName?: string;
}): Promise<void> {
  const run = options.run ?? (await loadBoundReviewLifecycle(options.octokit));
  if (!run || run.completed) return;
  const elapsed = (Date.now() - Date.parse(run.startedAt)) / 1000;
  const previous = run.steps.at(-1);
  if (previous?.status === "running" && previous.name === options.name) return;
  if (previous?.status === "running") {
    previous.name =
      options.completedName ||
      previous.name.replace(/^Gathering /, "Gathered ");
    previous.status = "completed";
    previous.durationSeconds = Math.max(
      0,
      elapsed -
        run.steps
          .slice(0, -1)
          .reduce((sum, step) => sum + (step.durationSeconds || 0), 0),
    );
  }
  run.steps.push({ name: options.name, status: "running" });
  const output = renderCheckRun({
    state: "in_progress",
    phase: "in_progress",
    head: run.head,
    steps: run.steps,
  });
  await updateReviewCheck({
    octokit: checkClient(options.octokit),
    owner: run.owner,
    repo: run.repo,
    checkId: run.checkId,
    status: "in_progress",
    ...output,
    warn: lifecycleWarning(run),
  });
  await saveReviewLifecycle(run);
}
export async function finishReviewLifecycle(options: {
  octokit: Octokits;
  run?: ReviewLifecycleRun;
  input?: ReviewRenderInput;
  error?: string;
}): Promise<void> {
  const run = options.run ?? (await loadBoundReviewLifecycle(options.octokit));
  if (!run || run.completed) return;
  const failed = !!options.error;
  let input: ReviewRenderInput = {
    ...(options.input ?? run.renderInput ?? { state: "failed" }),
    head: run.head,
    base: run.base,
    reviewState: run.state,
    durationSeconds: (Date.now() - Date.parse(run.startedAt)) / 1000,
    ...(failed ? { state: "failed", error: options.error } : {}),
    ...(run.superseded
      ? {
          state: "skipped",
          skipReason: "Superseded by a newer review or PR head.",
        }
      : {}),
  };
  if (
    !failed &&
    !run.superseded &&
    ["clean", "findings"].includes(input.state) &&
    (run.securityOnly || process.env.SECURITY_REVIEW_ENABLED === "true") &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(run.head)
  )
    run.state.securityReviewedHead = run.head;
  const warn = lifecycleWarning(run);
  let summary: string;
  try {
    summary = redactCredentials(renderReviewSummary(input));
  } catch (error) {
    run.state = run.previousState || { head: "", findings: [] };
    input = {
      state: "failed",
      head: run.head,
      reviewState: run.state,
      error: redactCredentials(
        error instanceof Error
          ? error.message
          : "The rendered review exceeded the platform output limit.",
      ),
      jobUrl: input.jobUrl,
    };
    summary = redactCredentials(renderReviewSummary(input));
  }
  const config = reviewConfigFromEnvironment();
  let terminalWriteAttempted = false;
  if (run.commentId && !run.superseded && config.review_summary !== "off")
    await optionalGitHubOperation(async () => {
      if (
        !(await ownsReviewSummary(options.octokit, run, terminalWriteAttempted))
      )
        return;
      terminalWriteAttempted = true;
      return options.octokit.rest.issues.updateComment({
        owner: run.owner,
        repo: run.repo,
        comment_id: run.commentId,
        body: fitReviewOutput(
          { ...input, reviewState: decodeReviewState(summary) || run.state },
          (value) =>
            `${
              config.review_summary === "description"
                ? renderReviewStateNote(value.reviewState)
                : redactCredentials(renderReviewSummary(value))
            }\n\n${sessionMarker(run, "completed")}`,
        ),
      });
    }, warn);
  if (!run.superseded && config.review_summary === "description")
    await publishDescriptionSummary(options.octokit, run, input);
  const last = run.steps.at(-1);
  if (last?.status === "running") {
    last.status = failed ? "failed" : "completed";
    if (!failed && last.name === "Posting review") last.name = "Posted review";
    last.durationSeconds = Math.max(
      0,
      (input.durationSeconds || 0) -
        run.steps
          .slice(0, -1)
          .reduce((sum, step) => sum + (step.durationSeconds || 0), 0),
    );
  }
  const conclusion = reviewCheckConclusion(
    input.findings || [],
    {
      failOnSeverity: config.fail_on_severity,
      securityBlockOnCritical: config.security_block_on_critical,
      securityBlockOnHigh: config.security_block_on_high,
    },
    failed || input.state === "failed",
  );
  const output = renderCheckRun({
    ...input,
    phase: "completed",
    steps: run.steps,
  });
  if (
    config.review_summary === "off" &&
    input.findings?.some((finding) => finding.outside_diff)
  )
    output.text = fitReviewOutput(
      { ...input, reviewState: undefined, previousBody: undefined },
      (candidate) =>
        `${renderReviewSummary(candidate)}\n\n${renderCheckRun({ ...candidate, phase: "completed" }).text}`,
    );
  await updateReviewCheck({
    octokit: checkClient(options.octokit),
    owner: run.owner,
    repo: run.repo,
    checkId: run.checkId,
    status: "completed",
    conclusion: input.state === "skipped" ? "neutral" : conclusion,
    ...output,
    warn,
  });
  if (config.review_reactions && run.reaction && !run.superseded) {
    const { id, targetId, kind } = run.reaction;
    await optionalGitHubOperation(async () => {
      if (!(await ownsReviewSummary(options.octokit, run, true))) return;
      return kind === "review_comment"
        ? options.octokit.rest.reactions.deleteForPullRequestComment({
            owner: run.owner,
            repo: run.repo,
            comment_id: targetId,
            reaction_id: id,
          })
        : kind === "issue_comment"
          ? options.octokit.rest.reactions.deleteForIssueComment({
              owner: run.owner,
              repo: run.repo,
              comment_id: targetId,
              reaction_id: id,
            })
          : options.octokit.rest.reactions.deleteForIssue({
              owner: run.owner,
              repo: run.repo,
              issue_number: targetId,
              reaction_id: id,
            });
    }, warn);
    const content =
      failed || input.state === "failed"
        ? "confused"
        : input.state === "clean"
          ? "hooray"
          : undefined;
    if (content)
      await optionalGitHubOperation(async () => {
        if (!(await ownsReviewSummary(options.octokit, run, true))) return;
        return kind === "review_comment"
          ? options.octokit.rest.reactions.createForPullRequestReviewComment({
              owner: run.owner,
              repo: run.repo,
              comment_id: targetId,
              content,
            })
          : kind === "issue_comment"
            ? options.octokit.rest.reactions.createForIssueComment({
                owner: run.owner,
                repo: run.repo,
                comment_id: targetId,
                content,
              })
            : options.octokit.rest.reactions.createForIssue({
                owner: run.owner,
                repo: run.repo,
                issue_number: targetId,
                content,
              });
      }, warn);
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    await fs.appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `${redactCredentials(renderStepSummary(input))}\n`,
    );
  run.completed = true;
  run.renderInput = input;
  await saveReviewLifecycle(run);
}
export function stateFindings(state: ReviewState): ReviewFinding[] {
  return state.findings.flatMap((item) => {
    const finding =
      item.finding ??
      (item.path && (item.body || item.title)
        ? normalizeFinding({
            ...item,
            severity: item.sev,
            body: item.body || item.title,
          })
        : undefined);
    return finding
      ? [
          {
            ...finding,
            state: item.state,
            threadUrl: item.url || finding.threadUrl,
            threadId: item.threadId || item.thread || finding.threadId,
          },
        ]
      : [];
  });
}

const DESCRIPTION_START = "<!-- droid-review-summary:start -->";
const DESCRIPTION_END = "<!-- droid-review-summary:end -->";
/** Only exact top-level marker pairs own description text. */
export function replaceReviewDescription(
  body: string,
  summary: string,
): string {
  const range = findReviewSummaryRange(body, "github");
  const block = `${DESCRIPTION_START}\n<a id="droid-review-summary"></a>\n\n${summary}\n${DESCRIPTION_END}`;
  if (!range)
    return `${body}${body && !body.endsWith("\n\n") ? (body.endsWith("\n") ? "\n" : "\n\n") : ""}${block}`;
  return body.slice(0, range.start) + block + body.slice(range.end);
}
async function publishDescriptionSummary(
  octokit: Octokits,
  run: ReviewLifecycleRun,
  input: ReviewRenderInput,
): Promise<void> {
  await optionalGitHubOperation(async () => {
    if (!(await ownsReviewSummary(octokit, run, true))) return;
    const body = replaceReviewDescription(
      run.pullRequest!.body,
      renderReviewSummary(input),
    );
    await octokit.rest.pulls.update({
      owner: run.owner,
      repo: run.repo,
      pull_number: run.prNumber,
      body,
    });
  }, lifecycleWarning(run));
}
