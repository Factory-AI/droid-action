import { describe, expect, it } from "bun:test";
import { generateReviewPrompt } from "../../../src/create-prompt/templates/review-prompt";
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
    githubContext: undefined,
    ...overrides,
  } as PreparedContext;
}

describe("generateReviewPrompt", () => {
  it("includes objectives and procedure steps", () => {
    const context = createBaseContext();

    const prompt = generateReviewPrompt(context);

    expect(prompt).toContain("Objectives:");
    expect(prompt).toContain("Re-check existing review comments");
    expect(prompt).toContain("git merge-base");
    expect(prompt).toContain("git diff");
    expect(prompt).toContain(
      "gh pr diff 42 --repo test-owner/test-repo",
    );
    expect(prompt).toContain("gh api repos/test-owner/test-repo/pulls/42/files");
    expect(prompt).toContain("github_inline_comment___create_inline_comment");
    expect(prompt).toContain("github_pr___resolve_review_thread");
    expect(prompt).toContain("every substantive comment must be inline on the changed line");
  });

  it("emphasizes accuracy gates and bug detection guidelines", () => {
    const prompt = generateReviewPrompt(createBaseContext());

    expect(prompt).toContain("How Many Findings to Return:");
    expect(prompt).toContain("Output all findings that the original author would fix");
    expect(prompt).toContain("Key Guidelines for Bug Detection:");
    expect(prompt).toContain("Priority Levels:");
    expect(prompt).toContain("[P0]");
    expect(prompt).toContain("Never raise purely stylistic");
    expect(prompt).toContain("Never repeat or re-raise an issue previously highlighted");
  });

  it("describes submission guidance", () => {
    const prompt = generateReviewPrompt(createBaseContext());

    expect(prompt).toContain("Prefer github_inline_comment___create_inline_comment");
    expect(prompt).toContain("gh api repos/test-owner/test-repo/pulls/42/reviews");
    expect(prompt).toContain("Do not approve or request changes");
    expect(prompt).toContain("github_pr___submit_review");
    expect(prompt).toContain("github_pr___resolve_review_thread");
    expect(prompt).toContain("skip submitting another comment to avoid redundancy");
  });
});
