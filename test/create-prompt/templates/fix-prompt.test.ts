import { describe, expect, it } from "bun:test";
import { generateFixPrompt } from "../../../src/create-prompt/templates/fix-prompt";
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
      commentBody: "@droid fix",
    },
    githubContext: undefined,
    ...overrides,
  } as PreparedContext;
}

describe("generateFixPrompt", () => {
  describe("top-level fix (issue_comment)", () => {
    it("generates prompt to fix all review findings", () => {
      const context = createBaseContext();
      const prompt = generateFixPrompt(context);

      expect(prompt).toContain("PR #42");
      expect(prompt).toContain("test-owner/test-repo");
      expect(prompt).toContain("gh pr diff 42");
      expect(prompt).toContain("Identify issues to fix");
      expect(prompt).toContain("git commit");
      expect(prompt).toContain("git push");
    });

    it("includes user instructions when provided", () => {
      const context = createBaseContext({
        eventData: {
          eventName: "issue_comment",
          commentId: "456",
          prNumber: "42",
          isPR: true as const,
          commentBody: "@droid fix the null pointer issue in auth.ts",
        },
      });
      const prompt = generateFixPrompt(context);

      expect(prompt).toContain("the null pointer issue in auth.ts");
    });

    it("fetches review comments via gh CLI", () => {
      const context = createBaseContext();
      const prompt = generateFixPrompt(context);

      expect(prompt).toContain(
        "gh api repos/test-owner/test-repo/pulls/42/comments",
      );
      expect(prompt).toContain(
        "gh api repos/test-owner/test-repo/pulls/42/reviews",
      );
    });
  });

  describe("thread fix (pull_request_review_comment)", () => {
    it("generates prompt focused on specific file and issue", () => {
      const context = createBaseContext({
        eventData: {
          eventName: "pull_request_review_comment",
          prNumber: "42",
          isPR: true as const,
          commentBody: "@droid fix",
        },
        fixContext: {
          parentCommentBody: "This has a race condition in the mutex lock",
          filePath: "src/server/handler.ts",
          line: 55,
        },
      });
      const prompt = generateFixPrompt(context);

      expect(prompt).toContain("src/server/handler.ts");
      expect(prompt).toContain("around line 55");
      expect(prompt).toContain("race condition in the mutex lock");
      expect(prompt).toContain(
        "Only fix the specific issue mentioned in the review comment",
      );
    });

    it("handles missing line number", () => {
      const context = createBaseContext({
        eventData: {
          eventName: "pull_request_review_comment",
          prNumber: "42",
          isPR: true as const,
          commentBody: "@droid fix",
        },
        fixContext: {
          parentCommentBody: "Missing error handling",
          filePath: "src/api.ts",
          line: null,
        },
      });
      const prompt = generateFixPrompt(context);

      expect(prompt).toContain("src/api.ts");
      expect(prompt).not.toContain("around line");
    });

    it("includes user instructions for thread fix", () => {
      const context = createBaseContext({
        eventData: {
          eventName: "pull_request_review_comment",
          prNumber: "42",
          isPR: true as const,
          commentBody: "@droid fix use try-catch instead",
        },
        fixContext: {
          parentCommentBody: "Missing error handling here",
          filePath: "src/api.ts",
          line: 10,
        },
      });
      const prompt = generateFixPrompt(context);

      expect(prompt).toContain("use try-catch instead");
    });
  });
});
