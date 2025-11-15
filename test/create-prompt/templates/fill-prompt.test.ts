import { describe, expect, it } from "bun:test";
import { generateFillPrompt } from "../../../src/create-prompt/templates/fill-prompt";
import type { PreparedContext } from "../../../src/create-prompt/types";
import type { FetchDataResult } from "../../../src/github/data/fetcher";

function createBaseContext(overrides: Partial<PreparedContext> = {}): PreparedContext {
  return {
    repository: "test-owner/test-repo",
    droidCommentId: "123",
    triggerPhrase: "@droid",
    eventData: {
      eventName: "issue_comment",
      commentId: "456",
      prNumber: "42",
      isPR: true,
      commentBody: "@droid fill please",
    },
    githubContext: undefined,
    ...overrides,
  } as PreparedContext;
}

function createBaseData(overrides: Partial<FetchDataResult> = {}): FetchDataResult {
  return {
    contextData: {
      title: "Test PR",
      body: "Existing body",
      author: { login: "author" },
      baseRefName: "main",
      headRefName: "feature/branch",
      headRefOid: "sha",
      createdAt: "2024-01-01T00:00:00Z",
      additions: 10,
      deletions: 2,
      state: "OPEN",
      commits: { totalCount: 1, nodes: [] },
      files: { nodes: [] },
      comments: { nodes: [] },
      reviews: { nodes: [] },
    },
    comments: [],
    changedFiles: [
      {
        path: "src/index.ts",
        additions: 5,
        deletions: 1,
        changeType: "MODIFIED",
      },
    ] as any,
    changedFilesWithSHA: [],
    reviewData: null,
    imageUrlMap: new Map(),
    triggerDisplayName: "Reviewer",
    ...overrides,
  } as FetchDataResult;
}

describe("generateFillPrompt", () => {
  it("includes gh CLI procedure and submission guidance", () => {
    const context = createBaseContext();
    const data = createBaseData();

    const prompt = generateFillPrompt(context, data);

    expect(prompt).toContain("Procedure:");
    expect(prompt).toContain("gh pr view 42 --repo test-owner/test-repo --json title,body");
    expect(prompt).toContain("gh pr diff 42 --repo test-owner/test-repo");
    expect(prompt).toContain("github_pr___update_pr_description");
    expect(prompt).toContain("Do not proceed if required commands fail");
  });

  it("tells Droid to read template files directly", () => {
    const context = createBaseContext();
    const data = createBaseData();

    const prompt = generateFillPrompt(context, data);

    expect(prompt).toContain(".github/PULL_REQUEST_TEMPLATE.md");
    expect(prompt).toContain("If none exist locally");
  });

  it("includes fallback section structure instructions", () => {
    const context = createBaseContext();
    const data = createBaseData();

    const prompt = generateFillPrompt(context, data);

    expect(prompt).toContain("## Summary");
    expect(prompt).toContain("## Changes");
    expect(prompt).toContain("[To be filled by author]");
  });
});
