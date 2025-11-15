import { describe, expect, test } from "bun:test";
import type { IssueCommentEvent } from "@octokit/webhooks-types";
import { shouldTriggerTag } from "../../src/tag";
import { createMockContext } from "../mockContext";

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
});
