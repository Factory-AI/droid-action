import { describe, expect, it } from "bun:test";
import {
  buildReviewSessionTag,
  REVIEW_SESSION_TAG_NAME,
} from "../../src/utils/review-session-tag";

describe("buildReviewSessionTag", () => {
  it("keeps the legacy tag name and stringifies the PR number", () => {
    const tag = buildReviewSessionTag({
      pass: "candidates",
      reviewType: "code",
      platform: "github",
      repo: "acme/widgets",
      pr: 42,
      securityReview: false,
      runId: "987",
      runAttempt: "2",
    });

    expect(tag).toEqual({
      name: REVIEW_SESSION_TAG_NAME,
      metadata: {
        pass: "candidates",
        reviewType: "code",
        platform: "github",
        repo: "acme/widgets",
        pr: "42",
        securityReview: "false",
        runId: "987",
        runAttempt: "2",
      },
    });
  });

  it("records the security review flag on code reviews only", () => {
    const input = {
      pass: "candidates",
      platform: "github",
      repo: "acme/widgets",
      pr: 42,
      securityReview: true,
    } as const;

    expect(
      buildReviewSessionTag({ ...input, reviewType: "code" }).metadata
        .securityReview,
    ).toBe("true");
    expect(
      "securityReview" in
        buildReviewSessionTag({ ...input, reviewType: "security" }).metadata,
    ).toBe(false);
  });

  it("omits run id and attempt when they are unavailable", () => {
    const tag = buildReviewSessionTag({
      pass: "validator",
      reviewType: "security",
      platform: "gitlab",
      repo: "group/sub/project",
      pr: 7,
      securityReview: false,
      runId: null,
      runAttempt: undefined,
    });

    expect(tag.metadata).toEqual({
      pass: "validator",
      reviewType: "security",
      platform: "gitlab",
      repo: "group/sub/project",
      pr: "7",
    });
    expect("runId" in tag.metadata).toBe(false);
    expect("runAttempt" in tag.metadata).toBe(false);
  });
});
