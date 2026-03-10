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
    eventAction: "workflow_run_failure",
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
  workflowName: "Typecheck",
  workflowConclusion: "failure",
  workflowHtmlUrl:
    "https://github.com/test-owner/test-repo/actions/runs/12345",
  workflowRunId: 12345,
  headSha: "abc123def456",
  headBranch: "fix/ci-pipeline",
};

describe("generateCIFailureReviewPrompt", () => {
  it("includes CI failure context as a preamble", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    expect(prompt).toContain("CI FAILURE CONTEXT");
    expect(prompt).toContain("Typecheck");
    expect(prompt).toContain("failure");
    expect(prompt).toContain("12345");
    expect(prompt).toContain("abc123def456");
    expect(prompt).toContain("fix/ci-pipeline");
  });

  it("wraps the existing review candidates prompt", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    // Should contain content from the base review candidates prompt
    expect(prompt).toContain("PR #42");
    expect(prompt).toContain("test-owner/test-repo");
    expect(prompt).toContain("review_candidates.json");
  });

  it("references pre-computed review artifacts", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    expect(prompt).toContain("/tmp/droid-prompts/pr.diff");
    expect(prompt).toContain("/tmp/droid-prompts/existing_comments.json");
    expect(prompt).toContain("/tmp/droid-prompts/pr_description.txt");
  });

  it("includes CI tool instructions before the base prompt", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    const ciContextPos = prompt.indexOf("CI FAILURE CONTEXT");
    const basePromptPos = prompt.indexOf("senior staff software engineer");

    expect(ciContextPos).toBeGreaterThan(-1);
    expect(basePromptPos).toBeGreaterThan(-1);
    expect(ciContextPos).toBeLessThan(basePromptPos);
  });

  it("instructs to call CI tools with the specific workflow run ID", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    expect(prompt).toContain("get_ci_status");
    expect(prompt).toContain("get_workflow_run_details");
    expect(prompt).toContain("download_job_log");
    expect(prompt).toContain("run ID 12345");
  });

  it("includes [CI-FAIL] comment format", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    expect(prompt).toContain("[CI-FAIL]");
  });

  it("includes guidance for non-PR-caused failures", () => {
    const prompt = generateCIFailureReviewPrompt(mockContext, mockCIContext);

    expect(prompt).toContain("flaky test");
    expect(prompt).toContain("pre-existing");
    expect(prompt).toContain("infrastructure issue");
  });
});
