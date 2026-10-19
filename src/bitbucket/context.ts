import type { BitbucketVariant } from "./types";
import { BITBUCKET_CLOUD_API_URL } from "./api/cloud";

/**
 * Resolves which pull request to review from the CI environment. Bitbucket
 * Pipelines provides everything for Cloud. Data Center has no built-in CI,
 * so its context comes from explicit variables, a pull-request URL (Jenkins
 * Bitbucket Branch Source sets CHANGE_URL), or CI-specific fallbacks.
 */

export class BitbucketContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BitbucketContextError";
  }
}

export type BitbucketInputs = {
  automaticReview: boolean;
  automaticSecurityReview: boolean;
  reviewDepth: string;
  reviewModel: string;
  reasoningEffort: string;
  includeSuggestions: boolean;
  reviewDrafts: boolean;
  buildStatus: boolean;
  settings: string;
};

type Common = {
  /** Pull request id, or null when this is not a pull-request build. */
  prId: number | null;
  /** Full commit SHA of the build, when the CI provides one. */
  commitSha: string | null;
  /** Link to the CI build/job for the tracking comment. */
  buildUrl: string | null;
  /** Identifies this CI run in session tags. */
  runId: string | null;
  inputs: BitbucketInputs;
};

export type BitbucketCloudContext = Common & {
  variant: "cloud";
  apiUrl: string;
  workspace: string;
  repoSlug: string;
  /** `workspace/repo` */
  repoFullName: string;
};

export type BitbucketDataCenterContext = Common & {
  variant: "datacenter";
  serverUrl: string;
  projectKey: string;
  repoSlug: string;
  /** `PROJECT/repo` */
  repoFullName: string;
};

export type ParsedBitbucketContext =
  | BitbucketCloudContext
  | BitbucketDataCenterContext;

type Env = NodeJS.ProcessEnv;

function opt(env: Env, ...names: string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "true";
}

function parsePrId(raw: string | null, source: string): number | null {
  if (raw === null) return null;
  // Bamboo and Jenkins sometimes prefix ids (e.g. "PR-12").
  const match = /^(?:PR-)?(\d+)$/i.exec(raw);
  if (!match) {
    throw new BitbucketContextError(
      `${source} must be a pull request number, got "${raw}".`,
    );
  }
  return Number(match[1]);
}

export type ParsedPrUrl =
  | {
      variant: "cloud";
      workspace: string;
      repoSlug: string;
      prId: number;
    }
  | {
      variant: "datacenter";
      serverUrl: string;
      projectKey: string;
      repoSlug: string;
      prId: number;
    };

/**
 * Accepts Cloud (`https://bitbucket.org/<ws>/<repo>/pull-requests/<id>`)
 * and Data Center (`<server>/projects/<KEY>/repos/<slug>/pull-requests/<id>`,
 * server may include a context path) pull request URLs.
 */
export function parsePullRequestUrl(url: string): ParsedPrUrl | null {
  const dc =
    /^(https?:\/\/.+?)\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)(?:[/?#].*)?$/i.exec(
      url.trim(),
    );
  if (dc) {
    return {
      variant: "datacenter",
      serverUrl: dc[1]!,
      projectKey: decodeURIComponent(dc[2]!),
      repoSlug: decodeURIComponent(dc[3]!),
      prId: Number(dc[4]),
    };
  }
  const cloud =
    /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)(?:[/?#].*)?$/i.exec(
      url.trim(),
    );
  if (cloud) {
    return {
      variant: "cloud",
      workspace: decodeURIComponent(cloud[1]!),
      repoSlug: decodeURIComponent(cloud[2]!),
      prId: Number(cloud[3]),
    };
  }
  return null;
}

function parseInputs(env: Env): BitbucketInputs {
  return {
    automaticReview: bool(env, "AUTOMATIC_REVIEW", true),
    automaticSecurityReview: bool(env, "AUTOMATIC_SECURITY_REVIEW", false),
    reviewDepth: opt(env, "REVIEW_DEPTH") ?? "deep",
    reviewModel: opt(env, "REVIEW_MODEL") ?? "",
    reasoningEffort: opt(env, "REASONING_EFFORT") ?? "",
    includeSuggestions: bool(env, "INCLUDE_SUGGESTIONS", true),
    reviewDrafts: bool(env, "REVIEW_DRAFTS", false),
    buildStatus: bool(env, "BUILD_STATUS", false),
    settings: env.DROID_SETTINGS ?? "",
  };
}

function detectVariant(env: Env, prUrl: ParsedPrUrl | null): BitbucketVariant {
  const explicit = opt(env, "BITBUCKET_VARIANT")?.toLowerCase();
  if (explicit) {
    if (explicit === "cloud") return "cloud";
    if (["datacenter", "data-center", "server", "dc"].includes(explicit)) {
      return "datacenter";
    }
    throw new BitbucketContextError(
      `BITBUCKET_VARIANT must be "cloud" or "datacenter", got "${explicit}".`,
    );
  }
  if (opt(env, "BITBUCKET_SERVER_URL")) return "datacenter";
  if (prUrl) return prUrl.variant;
  if (opt(env, "BITBUCKET_WORKSPACE")) return "cloud";
  throw new BitbucketContextError(
    "Could not determine the Bitbucket variant. In Bitbucket Pipelines this is automatic; " +
      "elsewhere set BITBUCKET_VARIANT (cloud|datacenter) plus BITBUCKET_SERVER_URL, " +
      "BITBUCKET_PROJECT_KEY, BITBUCKET_REPO_SLUG and BITBUCKET_PR_ID, or DROID_PR_URL.",
  );
}

function cloudBuildUrl(env: Env): string | null {
  const origin = opt(env, "BITBUCKET_GIT_HTTP_ORIGIN");
  const build = opt(env, "BITBUCKET_BUILD_NUMBER");
  if (!origin || !build) return null;
  const step = opt(env, "BITBUCKET_STEP_UUID");
  const base = `${origin.replace(/\/+$/, "")}/pipelines/results/${build}`;
  return step ? `${base}/steps/${encodeURIComponent(step)}` : base;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Jenkins sets CHANGE_ID for change requests from any SCM (GitHub, GitLab,
 * ...). It names a Bitbucket pull request only when CHANGE_URL is one.
 */
function jenkinsChangeId(env: Env, variant: BitbucketVariant): number | null {
  const changeId = opt(env, "CHANGE_ID");
  if (changeId === null) return null;
  const changeUrl = opt(env, "CHANGE_URL");
  const parsed = changeUrl ? parsePullRequestUrl(changeUrl) : null;
  if (parsed?.variant !== variant) {
    console.warn(
      `WARNING: ignoring Jenkins CHANGE_ID=${changeId} because CHANGE_URL (${changeUrl ?? "unset"}) ` +
        "is not a Bitbucket pull request URL. Set BITBUCKET_PR_ID to review this build anyway.",
    );
    return null;
  }
  return parsePrId(changeId, "CHANGE_ID");
}

export function parseBitbucketContext(
  env: Env = process.env,
): ParsedBitbucketContext {
  const prUrlRaw = opt(env, "DROID_PR_URL", "CHANGE_URL");
  const prUrl = prUrlRaw ? parsePullRequestUrl(prUrlRaw) : null;
  const variant = detectVariant(env, prUrl);
  const inputs = parseInputs(env);

  const explicitPrId = opt(env, "BITBUCKET_PR_ID");
  const prId =
    parsePrId(explicitPrId, "BITBUCKET_PR_ID") ??
    (prUrl && prUrl.variant === variant ? prUrl.prId : null) ??
    jenkinsChangeId(env, variant) ??
    parsePrId(opt(env, "bamboo_repository_pr_key"), "bamboo_repository_pr_key");

  const explicitServer = opt(env, "BITBUCKET_SERVER_URL");
  if (prUrl?.variant === "datacenter" && explicitServer) {
    const urlHost = hostOf(prUrl.serverUrl);
    const serverHost = hostOf(explicitServer);
    if (urlHost && serverHost && urlHost !== serverHost) {
      console.warn(
        `WARNING: the pull request URL points at ${urlHost} but BITBUCKET_SERVER_URL is ${serverHost}; ` +
          "API calls go to BITBUCKET_SERVER_URL. Make sure both name the same Bitbucket instance.",
      );
    }
  }

  const commitSha = opt(
    env,
    "BITBUCKET_COMMIT",
    "GIT_COMMIT",
    "bamboo_planRepository_revision",
  );
  const runId = opt(
    env,
    "DROID_RUN_ID",
    "BITBUCKET_PIPELINE_UUID",
    "BUILD_TAG",
    "bamboo_buildResultKey",
  );

  if (variant === "cloud") {
    const fromUrl = prUrl?.variant === "cloud" ? prUrl : null;
    const workspace = opt(env, "BITBUCKET_WORKSPACE") ?? fromUrl?.workspace;
    const repoSlug = opt(env, "BITBUCKET_REPO_SLUG") ?? fromUrl?.repoSlug;
    if (!workspace || !repoSlug) {
      throw new BitbucketContextError(
        "Missing Bitbucket Cloud context: BITBUCKET_WORKSPACE and BITBUCKET_REPO_SLUG are required " +
          "(set automatically in Bitbucket Pipelines).",
      );
    }
    return {
      variant,
      apiUrl: (
        opt(env, "BITBUCKET_API_URL") ?? BITBUCKET_CLOUD_API_URL
      ).replace(/\/+$/, ""),
      workspace,
      repoSlug,
      repoFullName: `${workspace}/${repoSlug}`,
      prId,
      commitSha,
      buildUrl:
        opt(env, "DROID_BUILD_URL") ??
        cloudBuildUrl(env) ??
        opt(env, "BUILD_URL"),
      runId,
      inputs,
    };
  }

  const fromUrl = prUrl?.variant === "datacenter" ? prUrl : null;
  const serverUrl = opt(env, "BITBUCKET_SERVER_URL") ?? fromUrl?.serverUrl;
  const projectKey = opt(env, "BITBUCKET_PROJECT_KEY") ?? fromUrl?.projectKey;
  const repoSlug = opt(env, "BITBUCKET_REPO_SLUG") ?? fromUrl?.repoSlug;
  const missing = [
    !serverUrl && "BITBUCKET_SERVER_URL",
    !projectKey && "BITBUCKET_PROJECT_KEY",
    !repoSlug && "BITBUCKET_REPO_SLUG",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new BitbucketContextError(
      `Missing Bitbucket Data Center context: ${missing.join(", ")}. Set them explicitly, ` +
        "or provide the pull request URL in DROID_PR_URL (Jenkins Bitbucket Branch Source sets CHANGE_URL).",
    );
  }
  return {
    variant,
    serverUrl: serverUrl!.replace(/\/+$/, ""),
    projectKey: projectKey!,
    repoSlug: repoSlug!,
    repoFullName: `${projectKey}/${repoSlug}`,
    prId,
    commitSha,
    buildUrl: opt(env, "DROID_BUILD_URL", "BUILD_URL", "bamboo_resultsUrl"),
    runId,
    inputs,
  };
}
