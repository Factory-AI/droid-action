import { describe, expect, it } from "bun:test";
import { generateFillPrompt } from "../../../src/create-prompt/templates/fill-prompt";
import type { PreparedContext } from "../../../src/create-prompt/types";

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

describe("generateFillPrompt", () => {
  it("includes gh CLI procedure and submission guidance", () => {
    const context = createBaseContext();

    const prompt = generateFillPrompt(context);

    expect(prompt).toContain("Procedure:");
    expect(prompt).toContain("gh pr view 42 --repo test-owner/test-repo --json title,body");
    expect(prompt).toContain("gh pr diff 42 --repo test-owner/test-repo");
    expect(prompt).toContain("github_pr___update_pr_description");
    expect(prompt).toContain("Do not proceed if required commands fail");
  });

  it("tells Droid to read template files directly", () => {
    const context = createBaseContext();

    const prompt = generateFillPrompt(context);

    expect(prompt).toContain(".github/PULL_REQUEST_TEMPLATE.md");
    expect(prompt).toContain("If none exist locally");
  });

  it("includes fallback section structure instructions", () => {
    const context = createBaseContext();

    const prompt = generateFillPrompt(context);

    expect(prompt).toContain("## Summary");
    expect(prompt).toContain("## Changes");
    expect(prompt).toContain("[To be filled by author]");
  });
});
