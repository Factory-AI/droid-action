#!/usr/bin/env bun

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { prepareContext } from "../src/create-prompt";
import {
  createMockContext,
  mockIssueOpenedContext,
  mockIssueAssignedContext,
  mockIssueCommentContext,
  mockPullRequestCommentContext,
  mockPullRequestReviewContext,
  mockPullRequestReviewCommentContext,
} from "./mockContext";

const BASE_ENV = {
  DROID_COMMENT_ID: "12345",
  GITHUB_TOKEN: "test-token",
};

describe("parseEnvVarsWithContext", () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env = {};
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("issue_comment event", () => {
    describe("on issue", () => {
      beforeEach(() => {
        process.env = {
          ...BASE_ENV,
          BASE_BRANCH: "main",
          DROID_BRANCH: "droid/issue-67890-20240101-1200",
        };
      });

      test("should parse issue_comment event correctly", () => {
        const result = prepareContext(
          mockIssueCommentContext,
          "12345",
          "main",
          "droid/issue-67890-20240101-1200",
        );

        expect(result.repository).toBe("test-owner/test-repo");
        expect(result.droidCommentId).toBe("12345");
        expect(result.triggerPhrase).toBe("@droid");
        expect(result.triggerUsername).toBe("contributor-user");
        expect(result.eventData.eventName).toBe("issue_comment");
        expect(result.eventData.isPR).toBe(false);
        if (
          result.eventData.eventName === "issue_comment" &&
          !result.eventData.isPR
        ) {
          expect(result.eventData.issueNumber).toBe("55");
          expect(result.eventData.commentId).toBe("12345678");
          expect(result.eventData.droidBranch).toBe(
            "droid/issue-67890-20240101-1200",
          );
          expect(result.eventData.baseBranch).toBe("main");
          expect(result.eventData.commentBody).toBe(
            "@droid can you help explain how to configure the logging system?",
          );
        }
      });

      test("should throw error when DROID_BRANCH is missing", () => {
        expect(() =>
          prepareContext(mockIssueCommentContext, "12345", "main"),
        ).toThrow("issue_comment on issues requires droidBranch and baseBranch");
      });

      test("should throw error when BASE_BRANCH is missing", () => {
        expect(() =>
          prepareContext(
            mockIssueCommentContext,
            "12345",
            undefined,
            "droid/issue-67890-20240101-1200",
          ),
        ).toThrow("issue_comment on issues requires droidBranch and baseBranch");
      });
    });

    describe("on PR", () => {
      test("should parse PR issue_comment event correctly", () => {
        process.env = BASE_ENV;
        const result = prepareContext(mockPullRequestCommentContext, "12345");

        expect(result.eventData.eventName).toBe("issue_comment");
        expect(result.eventData.isPR).toBe(true);
        expect(result.triggerUsername).toBe("reviewer-user");
        if (
          result.eventData.eventName === "issue_comment" &&
          result.eventData.isPR
        ) {
          expect(result.eventData.prNumber).toBe("789");
          expect(result.eventData.commentId).toBe("87654321");
          expect(result.eventData.commentBody).toBe(
            "/droid please review the changes and ensure we're not introducing any new memory issues",
          );
        }
      });
    });
  });

  describe("pull_request_review event", () => {
    test("should parse pull_request_review event correctly", () => {
      process.env = BASE_ENV;
      const result = prepareContext(mockPullRequestReviewContext, "12345");

      expect(result.eventData.eventName).toBe("pull_request_review");
      expect(result.eventData.isPR).toBe(true);
      expect(result.triggerUsername).toBe("senior-developer");
      if (result.eventData.eventName === "pull_request_review") {
        expect(result.eventData.prNumber).toBe("321");
        expect(result.eventData.commentBody).toBe(
          "@droid can you check if the error handling is comprehensive enough in this PR?",
        );
      }
    });
  });

  describe("pull_request_review_comment event", () => {
    test("should parse pull_request_review_comment event correctly", () => {
      process.env = BASE_ENV;
      const result = prepareContext(
        mockPullRequestReviewCommentContext,
        "12345",
      );

      expect(result.eventData.eventName).toBe("pull_request_review_comment");
      expect(result.eventData.isPR).toBe(true);
      expect(result.triggerUsername).toBe("code-reviewer");
      if (result.eventData.eventName === "pull_request_review_comment") {
        expect(result.eventData.prNumber).toBe("999");
        expect(result.eventData.commentId).toBe("99988877");
        expect(result.eventData.commentBody).toBe(
          "/droid is this the most efficient way to implement this algorithm?",
        );
      }
    });
  });

  describe("issues event", () => {
    beforeEach(() => {
      process.env = {
        ...BASE_ENV,
        BASE_BRANCH: "main",
        DROID_BRANCH: "droid/issue-42-20240101-1200",
      };
    });

    test("should parse issue opened event correctly", () => {
      const result = prepareContext(
        mockIssueOpenedContext,
        "12345",
        "main",
        "droid/issue-42-20240101-1200",
      );

      expect(result.eventData.eventName).toBe("issues");
      expect(result.eventData.isPR).toBe(false);
      expect(result.triggerUsername).toBe("john-doe");
      if (
        result.eventData.eventName === "issues" &&
        result.eventData.eventAction === "opened"
      ) {
        expect(result.eventData.issueNumber).toBe("42");
        expect(result.eventData.baseBranch).toBe("main");
        expect(result.eventData.droidBranch).toBe(
          "droid/issue-42-20240101-1200",
        );
      }
    });

    test("should parse issue assigned event correctly", () => {
      const result = prepareContext(
        mockIssueAssignedContext,
        "12345",
        "main",
        "droid/issue-123-20240101-1200",
      );

      expect(result.eventData.eventName).toBe("issues");
      expect(result.eventData.isPR).toBe(false);
      expect(result.triggerUsername).toBe("jane-smith");
      if (
        result.eventData.eventName === "issues" &&
        result.eventData.eventAction === "assigned"
      ) {
        expect(result.eventData.issueNumber).toBe("123");
        expect(result.eventData.baseBranch).toBe("main");
        expect(result.eventData.droidBranch).toBe(
          "droid/issue-123-20240101-1200",
        );
        expect(result.eventData.assigneeTrigger).toBe("droid-bot");
      }
    });

    test("should throw error when DROID_BRANCH is missing for issues", () => {
      expect(() =>
        prepareContext(mockIssueOpenedContext, "12345", "main"),
      ).toThrow("issues event requires baseBranch and droidBranch");
    });

    test("should throw error when BASE_BRANCH is missing for issues", () => {
      expect(() =>
        prepareContext(
          mockIssueOpenedContext,
          "12345",
          undefined,
          "droid/issue-42-20240101-1200",
        ),
      ).toThrow("issues event requires baseBranch and droidBranch");
    });

    test("allows issue assigned event even when configured trigger is empty", () => {
      const contextWithoutTriggers = createMockContext({
        ...mockIssueAssignedContext,
        inputs: {
          ...mockIssueAssignedContext.inputs,
          assigneeTrigger: "", // No assignee trigger
        },
      });

      const result = prepareContext(
        contextWithoutTriggers,
        "12345",
        "main",
        "droid/issue-123-20240101-1200",
      );

      if (
        result.eventData.eventName === "issues" &&
        result.eventData.eventAction === "assigned"
      ) {
        expect(result.eventData.assigneeTrigger).toBe("droid-bot");
      } else {
        throw new Error("Unexpected event data for issue assigned");
      }
    });
  });

  describe("context generation", () => {
    test("should generate context without legacy fields", () => {
      process.env = BASE_ENV;
      const context = createMockContext({
        ...mockPullRequestCommentContext,
        inputs: {
          ...mockPullRequestCommentContext.inputs,
        },
      });
      const result = prepareContext(context, "12345");

      // Verify context is created without legacy fields
      expect(result.repository).toBe("test-owner/test-repo");
      expect(result.droidCommentId).toBe("12345");
      expect(result.triggerPhrase).toBe("/droid");
      expect((result as any).customInstructions).toBeUndefined();
      expect((result as any).allowedTools).toBeUndefined();
    });
  });
});
