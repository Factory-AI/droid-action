import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  parseGitlabContext,
  isMergeRequestContext,
} from "../../src/gitlab/context";

const REQUIRED_CI_ENV = [
  "CI_SERVER_URL",
  "CI_API_V4_URL",
  "CI_PROJECT_ID",
  "CI_PROJECT_PATH",
  "CI_PROJECT_NAME",
  "CI_PROJECT_URL",
  "CI_COMMIT_SHA",
  "CI_COMMIT_BRANCH",
  "CI_COMMIT_TAG",
  "CI_PIPELINE_ID",
  "CI_PIPELINE_URL",
  "CI_PIPELINE_SOURCE",
  "CI_JOB_ID",
  "CI_JOB_URL",
  "CI_MERGE_REQUEST_IID",
  "CI_MERGE_REQUEST_SOURCE_BRANCH_SHA",
  "CI_MERGE_REQUEST_TARGET_BRANCH_SHA",
  "CI_MERGE_REQUEST_DIFF_BASE_SHA",
  "CI_MERGE_REQUEST_TITLE",
  "CI_MERGE_REQUEST_LABELS",
  "GITLAB_USER_LOGIN",
  "GITLAB_USER_NAME",
  "GITLAB_USER_EMAIL",
  "AUTOMATIC_REVIEW",
  "AUTOMATIC_SECURITY_REVIEW",
  "AUTOMATIC_FILL",
  "TRIGGER_PHRASE",
  "REVIEW_DEPTH",
  "REVIEW_MODEL",
  "REASONING_EFFORT",
  "FILL_MODEL",
  "SECURITY_MODEL",
  "SECURITY_SEVERITY_THRESHOLD",
  "SECURITY_BLOCK_ON_CRITICAL",
  "SECURITY_BLOCK_ON_HIGH",
  "SECURITY_NOTIFY_TEAM",
  "SECURITY_SCAN_SCHEDULE",
  "SECURITY_SCAN_DAYS",
  "DROID_SETTINGS",
];

function clearEnv() {
  for (const key of REQUIRED_CI_ENV) {
    delete process.env[key];
  }
}

describe("parseGitlabContext", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of REQUIRED_CI_ENV) {
      originalEnv[key] = process.env[key];
    }
    clearEnv();
  });

  afterEach(() => {
    clearEnv();
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it("parses a typical MR pipeline context", () => {
    process.env.CI_SERVER_URL = "https://gitlab.com";
    process.env.CI_API_V4_URL = "https://gitlab.com/api/v4";
    process.env.CI_PROJECT_ID = "12345";
    process.env.CI_PROJECT_PATH = "group/sub/repo-name";
    process.env.CI_PROJECT_NAME = "repo-name";
    process.env.CI_PROJECT_URL = "https://gitlab.com/group/sub/repo-name";
    process.env.CI_COMMIT_SHA = "abc123";
    process.env.CI_COMMIT_BRANCH = "feature/x";
    process.env.CI_PIPELINE_SOURCE = "merge_request_event";
    process.env.CI_PIPELINE_ID = "999";
    process.env.CI_PIPELINE_URL =
      "https://gitlab.com/group/sub/repo-name/-/pipelines/999";
    process.env.CI_MERGE_REQUEST_IID = "42";
    process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA = "src-sha";
    process.env.CI_MERGE_REQUEST_TARGET_BRANCH_SHA = "tgt-sha";
    process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA = "base-sha";
    process.env.CI_MERGE_REQUEST_TITLE = "Add feature x";
    process.env.AUTOMATIC_REVIEW = "true";

    const ctx = parseGitlabContext();

    expect(ctx.serverUrl).toBe("https://gitlab.com");
    expect(ctx.apiUrl).toBe("https://gitlab.com/api/v4");
    expect(ctx.project.id).toBe("12345");
    expect(ctx.project.pathWithNamespace).toBe("group/sub/repo-name");
    expect(ctx.commit.sha).toBe("abc123");
    expect(ctx.pipelineSource).toBe("merge_request_event");
    expect(isMergeRequestContext(ctx)).toBe(true);
    expect(ctx.mr?.iid).toBe(42);
    expect(ctx.mr?.diffBaseSha).toBe("base-sha");
    expect(ctx.inputs.automaticReview).toBe(true);
    expect(ctx.inputs.reviewDepth).toBe("deep");
    expect(ctx.inputs.securityScanDays).toBe(7);
  });

  it("parses a push-event context with no MR", () => {
    process.env.CI_PROJECT_ID = "1";
    process.env.CI_PROJECT_PATH = "g/r";
    process.env.CI_COMMIT_SHA = "deadbeef";
    process.env.CI_PIPELINE_SOURCE = "push";

    const ctx = parseGitlabContext();

    expect(ctx.mr).toBeNull();
    expect(isMergeRequestContext(ctx)).toBe(false);
  });

  it("trims trailing slashes from server and api urls", () => {
    process.env.CI_SERVER_URL = "https://gitlab.example.com///";
    process.env.CI_API_V4_URL = "https://gitlab.example.com/api/v4///";
    process.env.CI_PROJECT_ID = "1";
    process.env.CI_PROJECT_PATH = "g/r";
    process.env.CI_COMMIT_SHA = "x";

    const ctx = parseGitlabContext();

    expect(ctx.serverUrl).toBe("https://gitlab.example.com");
    expect(ctx.apiUrl).toBe("https://gitlab.example.com/api/v4");
  });

  it("falls back to derived api url when CI_API_V4_URL is unset", () => {
    process.env.CI_SERVER_URL = "https://self-hosted.example.com";
    process.env.CI_PROJECT_ID = "1";
    process.env.CI_PROJECT_PATH = "g/r";
    process.env.CI_COMMIT_SHA = "x";

    const ctx = parseGitlabContext();

    expect(ctx.apiUrl).toBe("https://self-hosted.example.com/api/v4");
  });

  it("throws when CI_PROJECT_ID is missing", () => {
    process.env.CI_PROJECT_PATH = "g/r";
    process.env.CI_COMMIT_SHA = "x";
    expect(() => parseGitlabContext()).toThrow(/CI_PROJECT_ID/);
  });

  it("clamps negative securityScanDays to at least 1", () => {
    process.env.CI_PROJECT_ID = "1";
    process.env.CI_PROJECT_PATH = "g/r";
    process.env.CI_COMMIT_SHA = "x";
    process.env.SECURITY_SCAN_DAYS = "-3";

    const ctx = parseGitlabContext();
    expect(ctx.inputs.securityScanDays).toBe(1);
  });

  it("falls back to 7 days when securityScanDays is invalid", () => {
    process.env.CI_PROJECT_ID = "1";
    process.env.CI_PROJECT_PATH = "g/r";
    process.env.CI_COMMIT_SHA = "x";
    process.env.SECURITY_SCAN_DAYS = "not-a-number";

    const ctx = parseGitlabContext();
    expect(ctx.inputs.securityScanDays).toBe(7);
  });

  it("surfaces DROID_SETTINGS as inputs.settings", () => {
    process.env.CI_PROJECT_ID = "1";
    process.env.CI_PROJECT_PATH = "g/r";
    process.env.CI_COMMIT_SHA = "x";
    process.env.DROID_SETTINGS = '{"reasoning_effort":"medium"}';

    const ctx = parseGitlabContext();
    expect(ctx.inputs.settings).toBe('{"reasoning_effort":"medium"}');
  });

  it("defaults inputs.settings to empty string when unset", () => {
    process.env.CI_PROJECT_ID = "1";
    process.env.CI_PROJECT_PATH = "g/r";
    process.env.CI_COMMIT_SHA = "x";

    const ctx = parseGitlabContext();
    expect(ctx.inputs.settings).toBe("");
  });
});
