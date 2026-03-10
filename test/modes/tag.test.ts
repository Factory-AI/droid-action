import { describe, expect, test } from "bun:test";
import type {
  IssueCommentEvent,
  CheckRunCompletedEvent,
} from "@octokit/webhooks-types";
import { shouldTriggerTag } from "../../src/tag";
import { createMockContext } from "../mockContext";
import type { ParsedGitHubContext } from "../../src/github/context";

describe("shouldTriggerTag", () => {
  test("returns true when trigger phrase is present", () => {
    const contextWithTrigger = createMockContext({
      eventName: "issue_comment",
      isPR: false,
      inputs: {
        ...createMockContext().inputs,
        triggerPhrase: "@droid",
      },
      payload: {
        comment: {
          body: "Hey @droid, can you help?",
        },
      } as IssueCommentEvent,
    });

    expect(shouldTriggerTag(contextWithTrigger)).toBe(true);
  });

  test("returns false when trigger phrase is missing", () => {
    const contextWithoutTrigger = createMockContext({
      eventName: "issue_comment",
      isPR: false,
      inputs: {
        ...createMockContext().inputs,
        triggerPhrase: "@droid",
      },
      payload: {
        comment: {
          body: "This is just a regular comment",
        },
      } as IssueCommentEvent,
    });

    expect(shouldTriggerTag(contextWithoutTrigger)).toBe(false);
  });

  test("returns true for PR contexts when automaticReview is enabled", () => {
    const contextWithAutomaticReview = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      inputs: {
        ...createMockContext().inputs,
        automaticReview: true,
      },
    });

    expect(shouldTriggerTag(contextWithAutomaticReview)).toBe(true);
  });

  test("returns true for PR contexts when automaticSecurityReview is enabled", () => {
    const contextWithAutomaticSecurityReview = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      inputs: {
        ...createMockContext().inputs,
        automaticSecurityReview: true,
      },
    });

    expect(shouldTriggerTag(contextWithAutomaticSecurityReview)).toBe(true);
  });

  test("returns true for check_run failure on PR when ciFailureReview is enabled", () => {
    const context: ParsedGitHubContext = {
      runId: "123",
      eventName: "check_run",
      eventAction: "completed",
      repository: {
        owner: "test-owner",
        repo: "test-repo",
        full_name: "test-owner/test-repo",
      },
      actor: "github-actions[bot]",
      entityNumber: 42,
      isPR: true,
      inputs: {
        ...createMockContext().inputs,
        ciFailureReview: true,
      },
      payload: {
        action: "completed",
        check_run: {
          id: 1,
          name: "CI / build",
          head_sha: "abc123",
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.com/test/repo/actions/runs/1",
          pull_requests: [{ number: 42 }],
        },
      } as unknown as CheckRunCompletedEvent,
    };

    expect(shouldTriggerTag(context)).toBe(true);
  });

  test("returns false for check_run success when ciFailureReview is enabled", () => {
    const context: ParsedGitHubContext = {
      runId: "123",
      eventName: "check_run",
      eventAction: "completed",
      repository: {
        owner: "test-owner",
        repo: "test-repo",
        full_name: "test-owner/test-repo",
      },
      actor: "github-actions[bot]",
      entityNumber: 42,
      isPR: true,
      inputs: {
        ...createMockContext().inputs,
        ciFailureReview: true,
      },
      payload: {
        action: "completed",
        check_run: {
          id: 1,
          name: "CI / build",
          head_sha: "abc123",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/test/repo/actions/runs/1",
          pull_requests: [{ number: 42 }],
        },
      } as unknown as CheckRunCompletedEvent,
    };

    expect(shouldTriggerTag(context)).toBe(false);
  });

  test("returns false for check_run failure when ciFailureReview is disabled", () => {
    const context: ParsedGitHubContext = {
      runId: "123",
      eventName: "check_run",
      eventAction: "completed",
      repository: {
        owner: "test-owner",
        repo: "test-repo",
        full_name: "test-owner/test-repo",
      },
      actor: "github-actions[bot]",
      entityNumber: 42,
      isPR: true,
      inputs: {
        ...createMockContext().inputs,
        ciFailureReview: false,
      },
      payload: {
        action: "completed",
        check_run: {
          id: 1,
          name: "CI / build",
          head_sha: "abc123",
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.com/test/repo/actions/runs/1",
          pull_requests: [{ number: 42 }],
        },
      } as unknown as CheckRunCompletedEvent,
    };

    expect(shouldTriggerTag(context)).toBe(false);
  });
});
