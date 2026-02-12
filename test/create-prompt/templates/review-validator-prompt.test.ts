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

  it("instructs reading PR description in Phase 1", () => {
    const context = createBaseContext({
      reviewArtifacts: {
        diffPath: "/tmp/test/pr.diff",
        commentsPath: "/tmp/test/existing_comments.json",
        descriptionPath: "/tmp/test/pr_description.txt",
      },
    });

    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain("Read the PR description");
    expect(prompt).toContain("/tmp/test/pr_description.txt");
    // Verify description is read before comments
    const descIdx = prompt.indexOf("Read the PR description");
    const commentsIdx = prompt.indexOf("Read existing comments");
    expect(descIdx).toBeLessThan(commentsIdx);
  });

  it("includes validation phases and output schema", () => {
    const context = createBaseContext();

    const prompt = generateReviewValidatorPrompt(context);

    expect(prompt).toContain("Phase 1: Load context");
    expect(prompt).toContain("Phase 2: Validate candidates");
    expect(prompt).toContain("Phase 3: Write review_validated.json");
    expect(prompt).toContain("Phase 4: Post approved items");
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
});
