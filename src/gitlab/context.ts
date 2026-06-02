export type ParsedGitlabContext = {
  serverUrl: string;
  apiUrl: string;
  pipelineId: string | null;
  pipelineUrl: string | null;
  jobId: string | null;
  jobUrl: string | null;
  pipelineSource: string | null;
  project: {
    id: string;
    path: string;
    pathWithNamespace: string;
    webUrl: string;
  };
  mr: {
    iid: number;
    sourceBranchSha: string | null;
    targetBranchSha: string | null;
    diffBaseSha: string | null;
    title: string | null;
    labels: string[];
  } | null;
  commit: {
    sha: string;
    branch: string | null;
    tag: string | null;
  };
  user: {
    login: string | null;
    name: string | null;
    email: string | null;
  };
  inputs: {
    automaticReview: boolean;
    automaticSecurityReview: boolean;
    automaticFill: boolean;
    triggerPhrase: string;
    reviewDepth: string;
    reviewModel: string;
    reasoningEffort: string;
    fillModel: string;
    securityModel: string;
    securitySeverityThreshold: string;
    securityBlockOnCritical: boolean;
    securityBlockOnHigh: boolean;
    securityNotifyTeam: string;
    securityScanSchedule: boolean;
    securityScanDays: number;
    settings: string;
  };
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required GitLab CI environment variable: ${name}. Are you running inside a GitLab CI job?`,
    );
  }
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name];
  return value && value.length > 0 ? value : null;
}

export function parseGitlabContext(): ParsedGitlabContext {
  const serverUrl = (process.env.CI_SERVER_URL || "https://gitlab.com").replace(
    /\/+$/,
    "",
  );
  const apiUrl = (process.env.CI_API_V4_URL || `${serverUrl}/api/v4`).replace(
    /\/+$/,
    "",
  );

  const projectId = required("CI_PROJECT_ID");
  const projectPath = required("CI_PROJECT_PATH");
  const projectName =
    process.env.CI_PROJECT_NAME || projectPath.split("/").pop()!;
  const projectUrl =
    process.env.CI_PROJECT_URL || `${serverUrl}/${projectPath}`;

  const mrIid = optional("CI_MERGE_REQUEST_IID");
  const labelsRaw = optional("CI_MERGE_REQUEST_LABELS") ?? "";
  const labels = labelsRaw
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const mr = mrIid
    ? {
        iid: parseInt(mrIid, 10),
        sourceBranchSha: optional("CI_MERGE_REQUEST_SOURCE_BRANCH_SHA"),
        targetBranchSha: optional("CI_MERGE_REQUEST_TARGET_BRANCH_SHA"),
        diffBaseSha: optional("CI_MERGE_REQUEST_DIFF_BASE_SHA"),
        title: optional("CI_MERGE_REQUEST_TITLE"),
        labels,
      }
    : null;

  return {
    serverUrl,
    apiUrl,
    pipelineId: optional("CI_PIPELINE_ID"),
    pipelineUrl: optional("CI_PIPELINE_URL"),
    jobId: optional("CI_JOB_ID"),
    jobUrl: optional("CI_JOB_URL"),
    pipelineSource: optional("CI_PIPELINE_SOURCE"),
    project: {
      id: projectId,
      path: projectName,
      pathWithNamespace: projectPath,
      webUrl: projectUrl,
    },
    mr,
    commit: {
      sha: required("CI_COMMIT_SHA"),
      branch: optional("CI_COMMIT_BRANCH"),
      tag: optional("CI_COMMIT_TAG"),
    },
    user: {
      login: optional("GITLAB_USER_LOGIN"),
      name: optional("GITLAB_USER_NAME"),
      email: optional("GITLAB_USER_EMAIL"),
    },
    inputs: {
      automaticReview: process.env.AUTOMATIC_REVIEW === "true",
      automaticSecurityReview: process.env.AUTOMATIC_SECURITY_REVIEW === "true",
      automaticFill: process.env.AUTOMATIC_FILL === "true",
      triggerPhrase: process.env.TRIGGER_PHRASE ?? "@droid",
      reviewDepth: process.env.REVIEW_DEPTH ?? "deep",
      reviewModel: process.env.REVIEW_MODEL ?? "",
      reasoningEffort: process.env.REASONING_EFFORT ?? "",
      fillModel: process.env.FILL_MODEL ?? "",
      securityModel: process.env.SECURITY_MODEL ?? "",
      securitySeverityThreshold:
        process.env.SECURITY_SEVERITY_THRESHOLD ?? "medium",
      securityBlockOnCritical:
        process.env.SECURITY_BLOCK_ON_CRITICAL !== "false",
      securityBlockOnHigh: process.env.SECURITY_BLOCK_ON_HIGH === "true",
      securityNotifyTeam: process.env.SECURITY_NOTIFY_TEAM ?? "",
      securityScanSchedule: process.env.SECURITY_SCAN_SCHEDULE === "true",
      securityScanDays: Math.max(
        1,
        parseInt(process.env.SECURITY_SCAN_DAYS ?? "7", 10) || 7,
      ),
      settings: process.env.DROID_SETTINGS ?? "",
    },
  };
}

export function isMergeRequestContext(
  ctx: ParsedGitlabContext,
): ctx is ParsedGitlabContext & { mr: NonNullable<ParsedGitlabContext["mr"]> } {
  return ctx.mr !== null;
}
