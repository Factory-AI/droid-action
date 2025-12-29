import { describe, expect, it } from "bun:test";
import { generateSecurityReviewPrompt } from "../../../src/create-prompt/templates/security-review-prompt";
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
      commentBody: "@droid security-review",
    },
    githubContext: undefined,
    ...overrides,
  } as PreparedContext;
}

describe("generateSecurityReviewPrompt", () => {
  it("includes security objectives and gh CLI procedure", () => {
    const prompt = generateSecurityReviewPrompt(createBaseContext());

    expect(prompt).toContain("security-focused code review");
    expect(prompt).toContain("Objectives:");
    expect(prompt).toContain("high-severity security issues");
    expect(prompt).toContain("gh pr diff 42 --repo test-owner/test-repo");
    expect(prompt).toContain(
      "gh api repos/test-owner/test-repo/pulls/42/files",
    );
    expect(prompt).toContain("github_inline_comment___create_inline_comment");
    expect(prompt).toContain("github_pr___submit_review");
  });

  it("lists security scope items", () => {
    const prompt = generateSecurityReviewPrompt(createBaseContext());

    expect(prompt).toContain("Injection");
    expect(prompt).toContain("SSRF");
    expect(prompt).toContain("Secrets");
    expect(prompt).toContain("Crypto");
  });
});
