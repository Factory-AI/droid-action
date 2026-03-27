import { describe, expect, it } from "bun:test";
import { generateReviewValidatorPrompt } from "../../../src/create-prompt/templates/review-validator-prompt";
import type { PreparedContext } from "../../../src/create-prompt/types";

function createBaseContext(
  overrides: Partial<PreparedContext> = {},
): PreparedContext {
  return {
    repository: "test-owner/test-repo",
    droidCommentId: "123",
    triggerPhrase: "@droid",
    eventData: {
      eventName: "issue_comment",
      commentId: "456",
      prNumber: "42",
      isPR: true,
      commentBody: "@droid review",
    },
    prBranchData: {
      headRefName: "feature/test",
      headRefOid: "abc123def",
    },
    githubContext: undefined,
    ...overrides,
  } as PreparedContext;
}

describe("generateReviewValidatorPrompt", () => {
  it("references PR description artifact in inputs", () => {
    const context = createBaseContext({
      reviewArtifacts: {
        diffPath: "/tmp/test/pr.diff",
        commentsPath: "/tmp/test/existing_comments.json",
        descriptionPath: "/tmp/test/pr_description.txt",
      },
    });

    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain("PR Description: `/tmp/test/pr_description.txt`");
  });

  it("uses fallback description path when artifacts are not provided", () => {
    const context = createBaseContext();

    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain("pr_description.txt");
  });

  it("instructs to invoke the review skill for Pass 2", () => {
    const context = createBaseContext();

    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain("Invoke the 'review' skill");
    expect(prompt).toContain("Pass 2: Validation");
  });

  it("preserves validating candidate review comments framing", () => {
    const context = createBaseContext();

    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain(
      "You are validating candidate review comments for PR",
    );
    expect(prompt).toContain("Phase 2 (validator) of a two-pass review pipeline");
  });

  it("instructs to post summary in tracking comment, not in submit_review body", () => {
    const context = createBaseContext();
    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain("github_comment___update_droid_comment");
    expect(prompt).toContain("Do **NOT** include a `body` parameter");
    expect(prompt).toContain(
      "Do **NOT** post the summary as a separate comment or as the body of `submit_review`",
    );
  });

  it("includes correct PR context", () => {
    const context = createBaseContext({
      prBranchData: {
        headRefName: "feat/branch",
        headRefOid: "sha999",
      },
      eventData: {
        eventName: "issue_comment",
        commentId: "456",
        prNumber: "77",
        isPR: true,
        commentBody: "@droid review",
        baseBranch: "main",
      },
    });

    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain("PR Number: 77");
    expect(prompt).toContain("PR Head SHA: sha999");
    expect(prompt).toContain("PR Base Ref: main");
  });

  it("includes output schema with validated results", () => {
    const context = createBaseContext();

    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain("review_validated");
    expect(prompt).toContain('"version": 1');
    expect(prompt).toContain('"status": "approved"');
    expect(prompt).toContain('"status": "rejected"');
  });

  it("includes suggestion block rules reference when suggestions enabled", () => {
    const context = createBaseContext({ includeSuggestions: true });

    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain("suggestion block rules");
  });

  it("excludes suggestion blocks when suggestions disabled", () => {
    const context = createBaseContext({ includeSuggestions: false });

    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain("Do NOT include code suggestion blocks");
    expect(prompt).not.toContain("suggestion block rules");
  });
});
