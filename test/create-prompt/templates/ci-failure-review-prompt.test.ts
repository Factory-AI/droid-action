import { describe, expect, it } from "bun:test";
import {
  generateCIFailureReviewPrompt,
  type CIFailureContext,
} from "../../../src/create-prompt/templates/ci-failure-review-prompt";
import type { PreparedContext } from "../../../src/create-prompt/types";

const mockContext: PreparedContext = {
  repository: "test-owner/test-repo",
  droidCommentId: "123",
  triggerPhrase: "@droid",
  eventData: {
    eventName: "pull_request",
    eventAction: "check_run_failure",
    isPR: true,
    prNumber: "42",
    baseBranch: "main",
  },
  prBranchData: {
    headRefName: "fix/ci-pipeline",
    headRefOid: "abc123def456",
  },
  reviewArtifacts: {
    diffPath: "/tmp/droid-prompts/pr.diff",
    commentsPath: "/tmp/droid-prompts/existing_comments.json",
    descriptionPath: "/tmp/droid-prompts/pr_description.txt",
  },
};

const mockCIContext: CIFailureContext = {
  checkRunName: "CI / unit-tests",
  checkRunConclusion: "failure",
  checkRunHtmlUrl: "https://github.com/test-owner/test-repo/actions/runs/12345",
  checkRunId: 12345,
  headSha: "abc123def456",
};

describe("generateCIFailureReviewPrompt", () => {
  it("includes CI failure context in the prompt", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    expect(prompt).toContain("CI / unit-tests");
    expect(prompt).toContain("failure");
    expect(prompt).toContain("12345");
    expect(prompt).toContain("abc123def456");
  });

  it("includes PR context", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    expect(prompt).toContain("PR #42");
    expect(prompt).toContain("test-owner/test-repo");
    expect(prompt).toContain("fix/ci-pipeline");
    expect(prompt).toContain("main");
  });

  it("references pre-computed review artifacts", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    expect(prompt).toContain("/tmp/droid-prompts/pr.diff");
    expect(prompt).toContain("/tmp/droid-prompts/existing_comments.json");
    expect(prompt).toContain("/tmp/droid-prompts/pr_description.txt");
  });

  it("includes CI tool instructions", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    expect(prompt).toContain("get_ci_status");
    expect(prompt).toContain("get_workflow_run_details");
    expect(prompt).toContain("download_job_log");
  });

  it("includes phase structure for systematic failure analysis", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    expect(prompt).toContain("Phase 1: Gather CI Failure Details");
    expect(prompt).toContain("Phase 2: Read PR Context");
    expect(prompt).toContain("Phase 3: Correlate Failures with Code Changes");
    expect(prompt).toContain("Phase 4: Report Findings");
    expect(prompt).toContain("Phase 5: Submit Review Summary");
  });

  it("includes guidance for non-PR-caused failures", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    expect(prompt).toContain("flaky test");
    expect(prompt).toContain("pre-existing failure");
    expect(prompt).toContain("infrastructure issue");
  });

  it("includes CI failure priority levels", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    expect(prompt).toContain("[P0] Build/compile failure");
    expect(prompt).toContain("[P1] Test failure");
    expect(prompt).toContain("[P1] Type error");
    expect(prompt).toContain("[P2] Lint failure");
  });

  it("uses [CI-FAIL] comment format prefix", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    expect(prompt).toContain("[CI-FAIL]");
  });
});
