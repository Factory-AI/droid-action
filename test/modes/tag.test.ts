import { describe, expect, test } from "bun:test";
import type {
  IssueCommentEvent,
  WorkflowRunCompletedEvent,
} from "@octokit/webhooks-types";
import { shouldTriggerTag } from "../../src/tag";
import { createMockContext, createMockAutomationContext } from "../mockContext";
import type { AutomationContext } from "../../src/github/context";

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

  test("returns true for workflow_run failure on PR when ciFailureReview is enabled", () => {
    const context: AutomationContext = {
      ...createMockAutomationContext({
        eventName: "workflow_run",
        inputs: {
          ...createMockContext().inputs,
          ciFailureReview: true,
        },
      }),
      payload: {
        action: "completed",
        workflow_run: {
          id: 1,
          name: "Typecheck",
          head_sha: "abc123",
          head_branch: "fix/something",
          conclusion: "failure",
          html_url: "https://github.com/test/repo/actions/runs/1",
          pull_requests: [{ number: 42, id: 1, url: "", head: { ref: "fix/something", sha: "abc123", repo: { id: 1, url: "", name: "test-repo" } }, base: { ref: "dev", sha: "000", repo: { id: 1, url: "", name: "test-repo" } } }],
        },
        workflow: { id: 1, name: "Typecheck" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "github-actions[bot]" },
      } as unknown as WorkflowRunCompletedEvent,
    };

    expect(shouldTriggerTag(context)).toBe(true);
  });

  test("returns false for workflow_run success when ciFailureReview is enabled", () => {
    const context: AutomationContext = {
      ...createMockAutomationContext({
        eventName: "workflow_run",
        inputs: {
          ...createMockContext().inputs,
          ciFailureReview: true,
        },
      }),
      payload: {
        action: "completed",
        workflow_run: {
          id: 1,
          name: "Typecheck",
          head_sha: "abc123",
          head_branch: "fix/something",
          conclusion: "success",
          html_url: "https://github.com/test/repo/actions/runs/1",
          pull_requests: [{ number: 42 }],
        },
        workflow: { id: 1, name: "Typecheck" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "github-actions[bot]" },
      } as unknown as WorkflowRunCompletedEvent,
    };

    expect(shouldTriggerTag(context)).toBe(false);
  });

  test("returns false for workflow_run failure when ciFailureReview is disabled", () => {
    const context: AutomationContext = {
      ...createMockAutomationContext({
        eventName: "workflow_run",
        inputs: {
          ...createMockContext().inputs,
          ciFailureReview: false,
        },
      }),
      payload: {
        action: "completed",
        workflow_run: {
          id: 1,
          name: "Typecheck",
          head_sha: "abc123",
          head_branch: "fix/something",
          conclusion: "failure",
          html_url: "https://github.com/test/repo/actions/runs/1",
          pull_requests: [{ number: 42 }],
        },
        workflow: { id: 1, name: "Typecheck" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "github-actions[bot]" },
      } as unknown as WorkflowRunCompletedEvent,
    };

    expect(shouldTriggerTag(context)).toBe(false);
  });

  test("returns false for workflow_run failure with no associated PR", () => {
    const context: AutomationContext = {
      ...createMockAutomationContext({
        eventName: "workflow_run",
        inputs: {
          ...createMockContext().inputs,
          ciFailureReview: true,
        },
      }),
      payload: {
        action: "completed",
        workflow_run: {
          id: 1,
          name: "Typecheck",
          head_sha: "abc123",
          head_branch: "fix/something",
          conclusion: "failure",
          html_url: "https://github.com/test/repo/actions/runs/1",
          pull_requests: [],
        },
        workflow: { id: 1, name: "Typecheck" },
        repository: { name: "test-repo", owner: { login: "test-owner" } },
        sender: { login: "github-actions[bot]" },
      } as unknown as WorkflowRunCompletedEvent,
    };

    expect(shouldTriggerTag(context)).toBe(false);
  });
});
