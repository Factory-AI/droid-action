import * as fs from "fs/promises";
import * as path from "path";
import * as core from "@actions/core";
import type { Octokits } from "../api/client";
import type { ParsedGitHubContext } from "../context";
import { DROID_APP_BOT_ID } from "../bot-identity";
import { GITHUB_SERVER_URL } from "../api/config";
import {
  decodeReviewState,
  findReviewSummaryRange,
  hasSummaryMarker,
  hasReviewSessionMarker,
  stripReviewSessionMarkers,
  type ReviewState,
} from "../../core/review/markers";
import {
  renderReviewSummary,
  renderReviewStateNote,
  renderStepSummary,
} from "../../core/review/render";
import type {
  CheckRunInput,
  ReviewRenderInput,
} from "../../core/review/render/types";
import { redactCredentials } from "../../utils/redact-credentials";
import { optionalGitHubOperation } from "./review-checks";
import { reviewConfigFromEnvironment } from "../../core/review/config";
import { fitReviewOutput } from "../../core/review/render/budget";

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
  warned?: boolean;
  skipReason?: string;
  steps: NonNullable<CheckRunInput["steps"]>;
  renderInput?: ReviewRenderInput;
  completed?: boolean;
  superseded?: boolean;
  pullRequest?: { title: string; body: string; baseSha: string };
  previousState?: ReviewState;
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
    state: { head: "", findings: [] },
    completed: false,
    base: process.env.REVIEW_BASE_SHA,
    startedAt: process.env.REVIEW_STARTED_AT || new Date().toISOString(),
    automatic: process.env.REVIEW_AUTOMATIC === "true",
    securityOnly: process.env.REVIEW_SECURITY_ONLY === "true",
    renderInput: undefined,
    skipReason: undefined,
    superseded: false,
    previousState: undefined,
    pullRequest: undefined,
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
  return run;
}
/** Fetch a diff between immutable commits, never trust the model-writable on-disk artifact for resolution decisions. */
export async function fetchImmutableReviewDiff(
  octokit: Octokits,
  target: { owner: string; repo: string; base: string; head: string },
): Promise<string> {
  if (
    !/^[a-f0-9]{7,64}$/i.test(target.base) ||
    !/^[a-f0-9]{7,64}$/i.test(target.head)
  )
    throw new Error("Review diff requires immutable base and head SHAs.");
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
type CommentAuthor = { id?: number; login?: string } | null | undefined;
function trustedAuthor(author: CommentAuthor, viewer?: string): boolean {
  return (
    author?.id === DROID_APP_BOT_ID ||
    (!!author?.login &&
      author.login === (process.env.DROID_BOT_LOGIN || viewer))
  );
}
async function viewerLogin(octokit: Octokits): Promise<string | undefined> {
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
    const response = await options.octokit.rest.issues.listComments({
      owner: options.owner,
      repo: options.repo,
      issue_number: options.prNumber,
      per_page: 100,
      page,
    });
    const comment = response.data.find(
      (comment) =>
        trustedAuthor(comment.user, viewer) &&
        hasSummaryMarker(comment.body || ""),
    );
    if (comment || response.data.length < 100) return comment;
  }
}
export async function prepareReviewLifecycle(options: {
  octokit: Octokits;
  context: ParsedGitHubContext;
  headSha: string;
  runAttempt?: string;
  baseSha?: string;
  securityOnly?: boolean;
  trackingCommentId?: number;
  skipReason?: string | null;
}): Promise<{
  commentId: number;
  state: ReviewState;
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
  const automatic = options.context.eventName === "pull_request";
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
    startedAt: new Date().toISOString(),
    steps: [],
    ...(options.skipReason ? { skipReason: options.skipReason } : {}),
  };
  const warn = lifecycleWarning(run);
  if (lookupFailed)
    warn(
      "Droid could not read review metadata. Check pull-requests: write permissions; this review will continue without incremental memory.",
    );
  const jobUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${options.context.runId}`;
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
    review_comment_id: run.commentId,
    review_started_at: run.startedAt,
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
  if (run.commentId && !run.superseded && config.review_summary !== "off")
    await optionalGitHubOperation(async () => {
      if (!(await ownsReviewSummary(options.octokit, run))) return;
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
  if (process.env.GITHUB_STEP_SUMMARY)
    await fs.appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `${redactCredentials(renderStepSummary(input))}\n`,
    );
  run.completed = true;
  run.renderInput = input;
  await saveReviewLifecycle(run);
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
