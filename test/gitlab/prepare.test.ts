import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../../src/entrypoints/gitlab-prepare";

const MR_ENV: Record<string, string> = {
  CI_SERVER_URL: "https://gitlab.com",
  CI_API_V4_URL: "https://gitlab.com/api/v4",
  CI_PROJECT_ID: "12345",
  CI_PROJECT_PATH: "group/repo",
  CI_PROJECT_NAME: "repo",
  CI_PROJECT_URL: "https://gitlab.com/group/repo",
  CI_COMMIT_SHA: "abc123",
  CI_PIPELINE_SOURCE: "merge_request_event",
  CI_PIPELINE_ID: "999",
  CI_PIPELINE_URL: "https://gitlab.com/group/repo/-/pipelines/999",
  CI_MERGE_REQUEST_IID: "42",
  CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: "src-sha",
  CI_MERGE_REQUEST_TARGET_BRANCH_SHA: "tgt-sha",
  CI_MERGE_REQUEST_DIFF_BASE_SHA: "base-sha",
  CI_MERGE_REQUEST_TITLE: "Add feature x",
};

const MANAGED_KEYS = [
  ...Object.keys(MR_ENV),
  "AUTOMATIC_REVIEW",
  "AUTOMATIC_SECURITY_REVIEW",
  "DROID_STATE_FILE",
  "GITLAB_TOKEN",
];

describe("gitlab-prepare run", () => {
  const originalEnv: Record<string, string | undefined> = {};
  let tmp: string;

  beforeEach(async () => {
    for (const key of MANAGED_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    Object.assign(process.env, MR_ENV);
    tmp = await mkdtemp(path.join(tmpdir(), "gitlab-prepare-"));
    process.env.DROID_STATE_FILE = path.join(tmp, ".droid-state.json");
  });

  afterEach(async () => {
    for (const key of MANAGED_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it("skips security review when automatic_review is off, even with security review on", async () => {
    process.env.AUTOMATIC_REVIEW = "false";
    process.env.AUTOMATIC_SECURITY_REVIEW = "true";

    // No GITLAB_TOKEN is set, so reaching token setup would throw.
    await run();

    const state = JSON.parse(
      await readFile(process.env.DROID_STATE_FILE!, "utf8"),
    );
    expect(state.reason).toBe("automatic-review-disabled");
    expect(state.shouldRunReview).toBe(false);
    expect(state.securityReviewEnabled).toBe(false);
    expect(state.trackingNoteId).toBeNull();
  });
});
