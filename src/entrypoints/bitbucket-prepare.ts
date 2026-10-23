#!/usr/bin/env bun

/**
 * Prepare step of the Bitbucket review (Cloud and Data Center).
 *
 *   1. Resolve the pull request from the CI environment; skip when this is
 *      not a pull-request build, automatic review is off, or the PR is a
 *      draft.
 *   2. Create or reuse the sticky tracking comment and, when enabled, mark
 *      the `droid-review` build status in progress. This happens before the
 *      diff is fetched so a failure from here on shows up on the PR.
 *   3. Write the review artifacts, resolve review depth, write the Pass-1
 *      prompt, the env shim, and the state file the later steps read.
 */

import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import {
  parseBitbucketContext,
  type ParsedBitbucketContext,
} from "../bitbucket/context";
import {
  isUnexpandedReference,
  resolveBitbucketAuth,
  withoutBitbucketCredentials,
} from "../bitbucket/token";
import {
  createBitbucketClient,
  type BitbucketTarget,
} from "../bitbucket/api/client";
import {
  buildTrackingCommentBody,
  findOwnTrackingComment,
  isOwnComment,
  isTrackingComment,
} from "../bitbucket/operations/tracking-comment";
import { computeReviewArtifacts } from "../bitbucket/data/review-artifacts";
import {
  generateBitbucketCandidatesPrompt,
  type BitbucketReviewPromptContext,
} from "../bitbucket/prompts";
import {
  BUILD_STATUS_KEY,
  BUILD_STATUS_NAME,
  candidatesFilePath,
  promptFilePath,
  promptsDir,
  resolvedEnvShimPath,
  validatedFilePath,
  writeState,
  type BitbucketPrepareState,
} from "../bitbucket/state";
import type {
  BitbucketBuildStatus,
  BitbucketClient,
  BitbucketComment,
  BitbucketPullRequest,
} from "../bitbucket/types";
import { resolveReviewConfig } from "../utils/review-depth";
import { applyModelPolicyFallback } from "../utils/model-policy";
import {
  buildReviewSessionTag,
  type ReviewPass,
} from "../utils/review-session-tag";
import { setupDroidSettings } from "../../base-action/src/setup-droid-settings";
import { downgradeUnsupportedTierAlias } from "./gitlab-prepare";

export class MissingFactoryApiKeyError extends Error {
  constructor() {
    super(
      "Missing FACTORY_API_KEY. Add your Factory API key as a secured CI variable named FACTORY_API_KEY.",
    );
    this.name = "MissingFactoryApiKeyError";
  }
}

export function targetFromContext(
  ctx: ParsedBitbucketContext,
  prId: number,
): BitbucketTarget {
  return ctx.variant === "cloud"
    ? {
        variant: "cloud",
        apiUrl: ctx.apiUrl,
        workspace: ctx.workspace,
        repoSlug: ctx.repoSlug,
        prId,
      }
    : {
        variant: "datacenter",
        serverUrl: ctx.serverUrl,
        projectKey: ctx.projectKey,
        repoSlug: ctx.repoSlug,
        prId,
      };
}

function sameTarget(a: BitbucketTarget, b: BitbucketTarget): boolean {
  const key = (t: BitbucketTarget) =>
    t.variant === "cloud"
      ? ["cloud", t.apiUrl, t.workspace, t.repoSlug, t.prId]
      : ["datacenter", t.serverUrl, t.projectKey, t.repoSlug, t.prId];
  return JSON.stringify(key(a)) === JSON.stringify(key(b));
}

/**
 * Where the post steps may write. The state file sits in a directory the
 * review passes can modify, so the pull request always comes from the CI
 * environment; a different target in state can only come from tampering.
 */
/**
 * Without a "who am I" answer (Cloud access tokens cannot call /2.0/user),
 * the author of the comment just created is the only trustworthy identity:
 * the server sets it, so no one can fake it with a pasted marker. Earlier
 * tracking comments by that same author are then removed, keeping one
 * tracking comment per pull request. Comments with replies stay, so no
 * conversation is lost.
 */
async function deleteStaleTrackingComments(
  client: BitbucketClient,
  comments: BitbucketComment[],
  created: BitbucketComment,
): Promise<void> {
  const replied = new Set(comments.map((c) => c.parentId));
  const stale = comments.filter(
    (c) =>
      c.id !== created.id &&
      !replied.has(c.id) &&
      isTrackingComment(c) &&
      isOwnComment(c, created.authorId),
  );
  for (const c of stale) {
    try {
      await client.deleteComment(c.id);
      console.log(`Deleted previous tracking comment ${c.id}`);
    } catch (error) {
      console.warn(
        `Could not delete previous tracking comment ${c.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function resolvePostTarget(state: {
  target: BitbucketTarget | null;
}): BitbucketTarget {
  const ctx = parseBitbucketContext();
  if (ctx.prId === null) {
    throw new Error(
      "The CI environment names no pull request; refusing to post.",
    );
  }
  const target = targetFromContext(ctx, ctx.prId);
  if (state.target && !sameTarget(state.target, target)) {
    throw new Error(
      `The state file names a different pull request than this build (${ctx.repoFullName ?? "unknown repo"} #${ctx.prId}); refusing to post.`,
    );
  }
  return target;
}

/**
 * Cloud abbreviates the PR head to 12 characters; prefer the CI's full SHA
 * when it is the same commit. Jenkins may build a merge commit instead, in
 * which case the PR's own head wins.
 */
export function resolveHeadSha(
  prHead: string | null,
  ciCommit: string | null,
): string | null {
  if (prHead && prHead.length >= 40) return prHead;
  if (ciCommit && (!prHead || ciCommit.startsWith(prHead))) return ciCommit;
  return prHead;
}

/** Posts the `droid-review` build status; never fails the step. */
export async function reportBuildStatus(
  client: BitbucketClient,
  sha: string | null,
  url: string | null,
  state: BitbucketBuildStatus["state"],
  description: string,
  sourceBranch: string | null,
): Promise<void> {
  if (!sha || !url) {
    console.warn(
      "BUILD_STATUS is enabled but the commit SHA or a build/PR URL is unknown; not posting a build status.",
    );
    return;
  }
  // An abbreviated hash can 404 or, if ambiguous, land on another commit.
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    console.warn(
      `BUILD_STATUS is enabled but only the abbreviated commit ${sha} is known; not posting a build status.`,
    );
    return;
  }
  try {
    await client.setBuildStatus(sha, {
      key: BUILD_STATUS_KEY,
      state,
      name: BUILD_STATUS_NAME,
      url,
      description,
      ...(sourceBranch ? { ref: `refs/heads/${sourceBranch}` } : {}),
    });
  } catch (error) {
    console.warn(
      `Could not post the ${BUILD_STATUS_KEY} build status: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function writeResolvedEnvShim(
  vars: Record<string, string | null>,
): Promise<void> {
  const filePath = resolvedEnvShimPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = [
    "# Generated by bitbucket-prepare; source this before droid exec.",
  ];
  for (const [k, v] of Object.entries(vars)) {
    lines.push(`export ${k}=${shellEscape(v ?? "")}`);
  }
  await fs.writeFile(filePath, lines.join("\n") + "\n");
}

export type PrepareDeps = {
  setupSettings?: (settings: string | undefined) => Promise<void>;
  /** Swap a tier alias the installed CLI does not know. */
  downgradeModel?: (model: string | undefined) => string | undefined;
  retryDelayMs?: number;
};

function defaultDowngrade(model: string | undefined): string | undefined {
  return downgradeUnsupportedTierAlias(model, (m) => {
    const result = spawnSync("droid", ["exec", "--model", m, "--list-tools"], {
      encoding: "utf8",
      timeout: 60_000,
      env: withoutBitbucketCredentials(process.env),
    });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  });
}

export async function run(
  deps: PrepareDeps = {},
): Promise<BitbucketPrepareState> {
  const ctx = parseBitbucketContext();

  const base: BitbucketPrepareState = {
    shouldRunReview: false,
    target: null,
    repoFullName: ctx.repoFullName,
    prId: ctx.prId,
    prWebUrl: null,
    trackingCommentId: null,
    headSha: ctx.commitSha,
    buildUrl: ctx.buildUrl,
    buildStatus: ctx.inputs.buildStatus,
    includeSuggestions: ctx.inputs.includeSuggestions,
    securityReviewEnabled: ctx.inputs.automaticSecurityReview,
    sourceBranch: null,
    targetBranch: null,
    promptPath: null,
    diffPath: null,
    commentsPath: null,
    descriptionPath: null,
    candidatesPath: null,
    validatedPath: null,
  };

  const skip = async (reason: string, message: string) => {
    console.log(message);
    const state = { ...base, reason };
    await writeState(state);
    return state;
  };

  if (ctx.prId === null) {
    return skip(
      "not-pull-request",
      "Not a pull request build; skipping Droid review.",
    );
  }
  if (!ctx.inputs.automaticReview) {
    return skip(
      "automatic-review-disabled",
      "AUTOMATIC_REVIEW is disabled; skipping Droid review.",
    );
  }

  const auth = resolveBitbucketAuth();
  const target = targetFromContext(ctx, ctx.prId);
  const client = createBitbucketClient(target, auth, {
    retryDelayMs: deps.retryDelayMs,
  });

  const pr: BitbucketPullRequest = await client.getPullRequest();
  const headSha = resolveHeadSha(pr.headSha, ctx.commitSha);
  const statusUrl = ctx.buildUrl ?? pr.webUrl;
  base.target = target;
  base.prWebUrl = pr.webUrl;
  base.headSha = headSha;
  base.baseSha = pr.baseSha;
  base.sourceBranch = pr.sourceBranch;
  base.targetBranch = pr.targetBranch;

  // No build status for a skipped draft: marking it ready pushes no commit,
  // so a SUCCESSFUL status here would satisfy a required-builds check for a
  // pull request that was never reviewed.
  if (pr.draft && !ctx.inputs.reviewDrafts) {
    return skip(
      "draft",
      `Pull request #${pr.id} is a draft; skipping Droid review.`,
    );
  }

  const factoryApiKey = process.env.FACTORY_API_KEY?.trim();
  if (!factoryApiKey || isUnexpandedReference(factoryApiKey)) {
    throw new MissingFactoryApiKeyError();
  }

  try {
    await (deps.setupSettings ?? setupDroidSettings)(
      ctx.inputs.settings || undefined,
    );
  } catch (err) {
    console.warn(
      "Failed to set up droid settings; continuing with defaults:",
      err,
    );
  }

  const securityReviewEnabled = ctx.inputs.automaticSecurityReview;
  const runningBody = buildTrackingCommentBody({
    state: "running",
    pipelineUrl: ctx.buildUrl,
    securityReviewRan: securityReviewEnabled,
  });

  const comments = await client.listComments();
  const currentUserId = await client.getCurrentUserId();
  const existing = findOwnTrackingComment(comments, currentUserId);
  let trackingCommentId: number;
  if (existing) {
    await client.updateComment(existing.id, runningBody);
    trackingCommentId = existing.id;
    console.log(`Reused tracking comment ${trackingCommentId}`);
  } else {
    const created = await client.createComment(runningBody);
    trackingCommentId = created.id;
    console.log(`Created tracking comment ${trackingCommentId}`);
    if (!currentUserId) {
      await deleteStaleTrackingComments(client, comments, created);
    }
  }
  // Recorded right away so the final step can report a failure that
  // happens anywhere after this point.
  base.trackingCommentId = trackingCommentId;
  await writeState({ ...base, reason: "prepare-incomplete" });

  if (ctx.inputs.buildStatus) {
    await reportBuildStatus(
      client,
      headSha,
      statusUrl,
      "INPROGRESS",
      "Droid is reviewing",
      pr.sourceBranch || null,
    );
  }

  console.log("Computing review artifacts (diff, comments, description)...");
  const artifacts = await computeReviewArtifacts({
    client,
    pr,
    comments,
    outDir: promptsDir(),
  });
  if (artifacts.diffTruncated) {
    console.warn(
      "WARNING: Bitbucket truncated the pull request diff (server diff size limit); the review covers only part of the changes.",
    );
    base.diffTruncated = true;
    await writeState({ ...base, reason: "prepare-incomplete" });
  }

  const reviewConfig = resolveReviewConfig({
    reviewModel: ctx.inputs.reviewModel,
    reasoningEffort: ctx.inputs.reasoningEffort,
    reviewDepth: ctx.inputs.reviewDepth,
  });
  const resolved = await applyModelPolicyFallback(
    {
      ...reviewConfig,
      model: (deps.downgradeModel ?? defaultDowngrade)(reviewConfig.model),
    },
    { flowLabel: "code review", modelInputName: "REVIEW_MODEL" },
  );
  console.log(
    `Resolved review config: depth=${ctx.inputs.reviewDepth} => model=${resolved.model ?? "(org default)"} effort=${resolved.reasoningEffort ?? "(none)"}`,
  );
  if (resolved.fallbackNote) console.warn(resolved.fallbackNote);

  const sessionTag = (pass: ReviewPass): string =>
    JSON.stringify(
      buildReviewSessionTag({
        pass,
        reviewType: "code",
        platform: "bitbucket",
        repo: ctx.repoFullName,
        pr: pr.id,
        securityReview: securityReviewEnabled,
        runId: ctx.runId,
      }),
    );

  await writeResolvedEnvShim({
    RESOLVED_MODEL: resolved.model ?? null,
    RESOLVED_REASONING_EFFORT: resolved.reasoningEffort ?? null,
    DROID_SESSION_TAG_CANDIDATES: sessionTag("candidates"),
    DROID_SESSION_TAG_VALIDATOR: sessionTag("validator"),
  });

  const promptCtx: BitbucketReviewPromptContext = {
    repoFullName: ctx.repoFullName,
    prId: pr.id,
    sourceBranch: pr.sourceBranch,
    targetBranch: pr.targetBranch,
    headSha: headSha ?? "",
    diffPath: artifacts.diffPath,
    commentsPath: artifacts.commentsPath,
    descriptionPath: artifacts.descriptionPath,
    candidatesPath: candidatesFilePath(),
    validatedPath: validatedFilePath(),
    includeSuggestions: ctx.inputs.includeSuggestions,
    securityReviewEnabled,
    diffTruncated: artifacts.diffTruncated,
  };
  const prompt = generateBitbucketCandidatesPrompt(promptCtx);
  const promptPath = promptFilePath();
  await fs.mkdir(path.dirname(promptPath), { recursive: true });
  await fs.writeFile(promptPath, prompt);
  console.log(`Wrote Pass-1 candidates prompt to ${promptPath}`);

  const state: BitbucketPrepareState = {
    ...base,
    shouldRunReview: true,
    reason: undefined,
    promptPath,
    diffPath: artifacts.diffPath,
    commentsPath: artifacts.commentsPath,
    descriptionPath: artifacts.descriptionPath,
    candidatesPath: promptCtx.candidatesPath,
    validatedPath: promptCtx.validatedPath,
  };
  await writeState(state);
  return state;
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(
      "bitbucket-prepare failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
}
