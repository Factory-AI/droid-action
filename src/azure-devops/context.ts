import { isUnexpandedMacro } from "./token";
import {
  detectHosting,
  normalizeCollectionUri,
  type AzureDevopsHosting,
} from "./api/config";

/**
 * Normalized view of the Azure Pipelines predefined variables a PR build
 * exposes. Azure Pipelines turns `System.PullRequest.PullRequestId` into
 * the env var `SYSTEM_PULLREQUEST_PULLREQUESTID`, and so on.
 */
export type ParsedAzureDevopsContext = {
  collectionUri: string;
  hosting: AzureDevopsHosting;
  project: { id: string | null; name: string };
  repository: {
    id: string;
    name: string;
    provider: string | null;
    webUrl: string;
  };
  build: {
    id: string | null;
    number: string | null;
    reason: string | null;
    url: string | null;
    jobId: string | null;
    jobUrl: string | null;
    jobAttempt: string | null;
    sourceVersion: string | null;
    sourcesDirectory: string | null;
  };
  pullRequest: {
    id: number;
    sourceBranch: string | null;
    targetBranch: string | null;
    sourceCommitId: string | null;
    isFork: boolean;
    webUrl: string;
  } | null;
  user: { name: string | null; email: string | null };
  inputs: {
    automaticReview: boolean;
    automaticSecurityReview: boolean;
    reviewDepth: string;
    reviewModel: string;
    reasoningEffort: string;
    includeSuggestions: boolean;
    securityBlockOnCritical: boolean;
    securityBlockOnHigh: boolean;
    settings: string;
  };
};

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  if (!value || isUnexpandedMacro(value)) return null;
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = optional(env, name);
  if (!value) {
    throw new Error(
      `Missing required Azure Pipelines variable: ${name}. Are you running inside an Azure Pipelines job?`,
    );
  }
  return value;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean) {
  const value = optional(env, name)?.toLowerCase();
  if (value === undefined || value === null) return fallback;
  return value === "true";
}

export function parseAzureDevopsContext(
  env: NodeJS.ProcessEnv = process.env,
): ParsedAzureDevopsContext {
  const collectionUri = normalizeCollectionUri(
    optional(env, "SYSTEM_COLLECTIONURI") ??
      required(env, "SYSTEM_TEAMFOUNDATIONCOLLECTIONURI"),
  );
  const projectName = required(env, "SYSTEM_TEAMPROJECT");
  const projectSegment = encodeURIComponent(projectName);
  const repositoryId = required(env, "BUILD_REPOSITORY_ID");
  const repositoryName = optional(env, "BUILD_REPOSITORY_NAME") ?? repositoryId;
  const repoWebUrl = `${collectionUri}/${projectSegment}/_git/${encodeURIComponent(repositoryName)}`;

  const buildId = optional(env, "BUILD_BUILDID");
  const jobId = optional(env, "SYSTEM_JOBID");
  const buildUrl = buildId
    ? `${collectionUri}/${projectSegment}/_build/results?buildId=${encodeURIComponent(buildId)}`
    : null;
  const jobUrl =
    buildUrl && jobId
      ? `${buildUrl}&view=logs&j=${encodeURIComponent(jobId)}`
      : null;

  const prIdRaw = optional(env, "SYSTEM_PULLREQUEST_PULLREQUESTID");
  const prId = prIdRaw ? Number.parseInt(prIdRaw, 10) : NaN;
  const pullRequest =
    Number.isInteger(prId) && prId > 0
      ? {
          id: prId,
          sourceBranch: optional(env, "SYSTEM_PULLREQUEST_SOURCEBRANCH"),
          targetBranch: optional(env, "SYSTEM_PULLREQUEST_TARGETBRANCH"),
          sourceCommitId: optional(env, "SYSTEM_PULLREQUEST_SOURCECOMMITID"),
          isFork: flag(env, "SYSTEM_PULLREQUEST_ISFORK", false),
          webUrl: `${repoWebUrl}/pullrequest/${prId}`,
        }
      : null;

  return {
    collectionUri,
    hosting: detectHosting(collectionUri),
    project: { id: optional(env, "SYSTEM_TEAMPROJECTID"), name: projectName },
    repository: {
      id: repositoryId,
      name: repositoryName,
      provider: optional(env, "BUILD_REPOSITORY_PROVIDER"),
      webUrl: repoWebUrl,
    },
    build: {
      id: buildId,
      number: optional(env, "BUILD_BUILDNUMBER"),
      reason: optional(env, "BUILD_REASON"),
      url: buildUrl,
      jobId,
      jobUrl,
      jobAttempt: optional(env, "SYSTEM_JOBATTEMPT"),
      sourceVersion: optional(env, "BUILD_SOURCEVERSION"),
      sourcesDirectory: optional(env, "BUILD_SOURCESDIRECTORY"),
    },
    pullRequest,
    user: {
      name: optional(env, "BUILD_REQUESTEDFOR"),
      email: optional(env, "BUILD_REQUESTEDFOREMAIL"),
    },
    inputs: {
      automaticReview: flag(env, "AUTOMATIC_REVIEW", true),
      automaticSecurityReview: flag(env, "AUTOMATIC_SECURITY_REVIEW", false),
      reviewDepth: optional(env, "REVIEW_DEPTH") ?? "deep",
      reviewModel: optional(env, "REVIEW_MODEL") ?? "",
      reasoningEffort: optional(env, "REASONING_EFFORT") ?? "",
      includeSuggestions: flag(env, "INCLUDE_SUGGESTIONS", true),
      securityBlockOnCritical: flag(env, "SECURITY_BLOCK_ON_CRITICAL", true),
      securityBlockOnHigh: flag(env, "SECURITY_BLOCK_ON_HIGH", false),
      settings: optional(env, "DROID_SETTINGS") ?? "",
    },
  };
}

/** Why this build must not run a review, or null when it should. */
export function reviewSkipReason(ctx: ParsedAzureDevopsContext): string | null {
  if (ctx.build.reason !== "PullRequest" || !ctx.pullRequest) {
    return `not-pull-request-build (Build.Reason=${ctx.build.reason ?? "unset"})`;
  }
  if (ctx.repository.provider && ctx.repository.provider !== "TfsGit") {
    return `unsupported-repository-provider (${ctx.repository.provider})`;
  }
  if (ctx.pullRequest.isFork) {
    // Pipelines withhold secrets from fork PR builds, and the job token
    // cannot be trusted with fork code either.
    return "fork-pull-request";
  }
  if (!ctx.inputs.automaticReview) {
    return "automatic-review-disabled";
  }
  return null;
}

/** Strips `refs/heads/` for display. */
export function shortRefName(ref: string | null | undefined): string {
  if (!ref) return "";
  return ref.replace(/^refs\/heads\//, "");
}
