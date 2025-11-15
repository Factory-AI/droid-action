import { describe, expect, it } from "bun:test";
import { generateReviewPrompt } from "../../../src/create-prompt/templates/review-prompt";
import type { PreparedContext } from "../../../src/create-prompt/types";
import type { FetchDataResult } from "../../../src/github/data/fetcher";

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

function createBaseData(
  overrides: Partial<FetchDataResult> = {},
): FetchDataResult {
  return {
    contextData: {
      title: "Review PR",
      body: "Existing body",
      author: { login: "author" },
      baseRefName: "main",
      headRefName: "feature/review",
      headRefOid: "deadbeef",
      createdAt: "2024-01-01T00:00:00Z",
      additions: 5,
      deletions: 1,
      state: "OPEN",
      commits: { totalCount: 1, nodes: [] },
      files: { nodes: [] },
      comments: { nodes: [] },
      reviews: { nodes: [] },
    },
    comments: [],
    changedFiles: [],
    changedFilesWithSHA: [],
    reviewData: null,
    imageUrlMap: new Map(),
    triggerDisplayName: "Reviewer",
    ...overrides,
  } as FetchDataResult;
}

describe("generateReviewPrompt", () => {
  it("includes objectives and procedure steps", () => {
    const context = createBaseContext();
    const data = createBaseData();

    const prompt = generateReviewPrompt(context, data);

    expect(prompt).toContain("Objectives:");
    expect(prompt).toContain("Re-check existing review comments");
    expect(prompt).toContain("gh pr diff 42 --repo test-owner/test-repo");
    expect(prompt).toContain("gh api repos/test-owner/test-repo/pulls/42/files");
    expect(prompt).toContain("github_inline_comment___create_inline_comment");
    expect(prompt).toContain("github_pr___resolve_review_thread");
    expect(prompt).toContain("every substantive comment must be inline on the changed line");
  });

  it("emphasizes accuracy gates and comment limits", () => {
    const prompt = generateReviewPrompt(createBaseContext(), createBaseData());

    expect(prompt).toContain("cap at 10 comments total");
    expect(prompt).toContain("Never raise purely stylistic");
    expect(prompt).toContain("Maximum 10 inline comments");
    expect(prompt).toContain("False positives are very undesirable");
    expect(prompt).toContain("Never repeat or re-raise an issue previously highlighted");
  });

  it("describes submission guidance", () => {
    const prompt = generateReviewPrompt(createBaseContext(), createBaseData());

    expect(prompt).toContain("Prefer github_inline_comment___create_inline_comment");
    expect(prompt).toContain("gh api repos/test-owner/test-repo/pulls/42/reviews");
    expect(prompt).toContain("Do not approve or request changes");
    expect(prompt).toContain("github_pr___submit_review");
    expect(prompt).toContain("github_pr___resolve_review_thread");
    expect(prompt).toContain("skip submitting another comment to avoid redundancy");
  });
});
