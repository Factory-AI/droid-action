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

    expect(prompt).toContain("## Objectives");
    expect(prompt).toContain("Re-check existing review comments");
    expect(prompt).toContain("git merge-base");
    expect(prompt).toContain("git --no-pager diff $MERGE_BASE..HEAD");
    expect(prompt).toContain("github_inline_comment___create_inline_comment");
    expect(prompt).toContain("**Do NOT call** `github_pr___resolve_review_thread`");
  });

  it("emphasizes accuracy gates and bug detection guidelines", () => {
    const prompt = generateReviewPrompt(createBaseContext());

    expect(prompt).toContain("## Priority Levels");
    expect(prompt).toContain("[P0]");
    expect(prompt).toContain(
      "Never open a new finding for an issue previously reported by this bot",
    );
  });

  it("describes submission guidance", () => {
    const prompt = generateReviewPrompt(createBaseContext());

    expect(prompt).toContain("Use `github_inline_comment___create_inline_comment`");
    expect(prompt).toContain("Do **not** approve or request changes");
    expect(prompt).toContain("github_pr___submit_review");
    expect(prompt).toContain("### When NOT to submit");
    expect(prompt).toContain("All findings are low-severity (P2/P3)");
  });
});
