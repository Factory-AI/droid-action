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
    expect(prompt).toContain("Review the current PR diff");
    expect(prompt).toContain("gh pr diff 42 --repo test-owner/test-repo");
    expect(prompt).toContain(
      "gh api repos/test-owner/test-repo/pulls/42/files",
    );
    expect(prompt).toContain("code-review-results.json");
    expect(prompt).toContain("Do NOT post inline comments");
  });

  it("emphasizes accuracy gates and comment limits", () => {
    const prompt = generateReviewPrompt(createBaseContext());

    expect(prompt).toContain("cap at 10 comments total");
    expect(prompt).toContain("Never raise purely stylistic");
    expect(prompt).toContain("Maximum 10 inline comments");
    expect(prompt).toContain("False positives are very undesirable");
    expect(prompt).toContain(
      "Never repeat or re-raise an issue previously highlighted",
    );
  });

  it("describes output format with Greptile-style summary", () => {
    const prompt = generateReviewPrompt(createBaseContext());

    expect(prompt).toContain("code-review-results.json");
    expect(prompt).toContain("github_comment___update_droid_comment");
    expect(prompt).toContain(
      "Inline comments will be posted after all reviews complete",
    );
    expect(prompt).toContain("### Summary");
    expect(prompt).toContain("### Key Changes");
    expect(prompt).toContain("### Important Files Changed");
    expect(prompt).toContain("### Review Findings");
  });
});
