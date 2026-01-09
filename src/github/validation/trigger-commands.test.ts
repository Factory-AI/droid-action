import { describe, expect, it } from "bun:test";
import { checkContainsTrigger } from "./trigger";
import type { ParsedGitHubContext } from "../context";
import type {
  IssueCommentEvent,
  IssuesEvent,
  PullRequestEvent,
  PullRequestReviewCommentEvent,
  PullRequestReviewEvent,
} from "@octokit/webhooks-types";

type ContextOverrides = Partial<Omit<ParsedGitHubContext, "payload">> & {
  payload?: unknown;
};

const defaultPayload = {
  action: "created",
  comment: {
    body: "",
    created_at: "",
  },
  issue: {
    number: 123,
    pull_request: { url: "" },
    body: "",
    title: "",
  },
} as unknown as IssueCommentEvent;

// Helper function to create a mock context
function createMockContext(
  overrides: ContextOverrides = {},
): ParsedGitHubContext {
  return {
    runId: "run-1",
    eventName: "issue_comment",
    eventAction: "created",
    actor: "test-user",
    repository: {
      owner: "test-owner",
      repo: "test-repo",
      full_name: "test-owner/test-repo",
    },
    entityNumber: 123,
    isPR: true,
    inputs: {
      triggerPhrase: "@droid",
      assigneeTrigger: "",
      labelTrigger: "",
      allowedBots: "",
      allowedNonWriteUsers: "",
      botId: "41898282",
      botName: "droid[bot]",
      trackProgress: false,
      automaticReview: false,
      useStickyComment: false,
    },
    payload: defaultPayload,
    ...overrides,
  } as ParsedGitHubContext;
}

describe("checkContainsTrigger with commands", () => {
  it("should trigger on @droid fill in PR body", () => {
    const context = createMockContext({
      eventName: "pull_request",
      eventAction: "opened",
      payload: {
        pull_request: {
          body: "This PR adds a new feature.\n\n@droid fill",
          title: "Add feature",
          number: 123,
        },
      } as unknown as PullRequestEvent,
    });

    expect(checkContainsTrigger(context)).toBe(true);
  });

  it("should trigger on @droid fill in issue comment", () => {
    const context = createMockContext({
      eventName: "issue_comment",
      eventAction: "created",
      payload: {
        comment: {
          body: "Can you @droid fill the description?",
        },
      } as unknown as IssueCommentEvent,
    });

    expect(checkContainsTrigger(context)).toBe(true);
  });

  it("should trigger on @droid review in PR review comment", () => {
    const context = createMockContext({
      eventName: "pull_request_review_comment",
      eventAction: "created",
      payload: {
        comment: {
          body: "@droid review this section please",
        },
        pull_request: {
          number: 123,
        },
      } as unknown as PullRequestReviewCommentEvent,
    });

    expect(checkContainsTrigger(context)).toBe(true);
  });

  it("should trigger on @droid review in PR review body", () => {
    const context = createMockContext({
      eventName: "pull_request_review",
      eventAction: "submitted",
      payload: {
        review: {
          body: "LGTM but @droid review the tests",
        },
        pull_request: {
          number: 123,
        },
      } as unknown as PullRequestReviewEvent,
    });

    expect(checkContainsTrigger(context)).toBe(true);
  });

  it("should not trigger on generic @droid without specific command", () => {
    const context = createMockContext({
      eventName: "issue_comment",
      eventAction: "created",
      payload: {
        comment: {
          body: "@droid can you help?",
        },
      } as unknown as IssueCommentEvent,
    });

    // This should still trigger because of the existing trigger phrase logic
    // but now it will be handled as default command
    expect(checkContainsTrigger(context)).toBe(true);
  });

  it("should trigger on @droid fill case insensitive", () => {
    const context = createMockContext({
      eventName: "issue_comment",
      eventAction: "created",
      payload: {
        comment: {
          body: "@DROID FILL",
        },
      } as unknown as IssueCommentEvent,
    });

    expect(checkContainsTrigger(context)).toBe(true);
  });

  it("should not trigger without @droid mention", () => {
    const context = createMockContext({
      eventName: "issue_comment",
      eventAction: "created",
      payload: {
        comment: {
          body: "Just a regular comment",
        },
      } as unknown as IssueCommentEvent,
    });

    expect(checkContainsTrigger(context)).toBe(false);
  });

  it("should trigger on @droid fill in issue body", () => {
    const context = createMockContext({
      eventName: "issues",
      eventAction: "opened",
      isPR: false,
      payload: {
        issue: {
          body: "Issue description\n@droid fill",
          title: "Bug report",
          number: 123,
        },
      } as unknown as IssuesEvent,
    });

    expect(checkContainsTrigger(context)).toBe(true);
  });
});
