import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import { prepareReviewMode } from "../../../src/tag/commands/review";
import { createMockContext } from "../../mockContext";
import * as reviewInput from "../../../src/github/data/review-input";
import * as lifecycle from "../../../src/github/operations/review-lifecycle";

const RUN = { head: "123abc" } as lifecycle.ReviewLifecycleRun;

function octokitFor(pullRequest: Record<string, unknown>) {
  return {
    graphql: () => Promise.resolve({ repository: { pullRequest } }),
  } as any;
}

const PULL_REQUEST = {
  baseRefName: "main",
  headRefName: "feature/review",
  headRefOid: "123abc",
  isCrossRepository: true,
  title: "PR for review",
  body: "Existing body",
};

describe("prepareReviewMode", () => {
  let lifecycleSpy: ReturnType<typeof spyOn>;
  let inputSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let lifecycleSkip: string | undefined;

  beforeEach(() => {
    lifecycleSkip = undefined;
    lifecycleSpy = spyOn(
      lifecycle,
      "prepareReviewLifecycle",
    ).mockImplementation(async (options) => ({
      commentId: options.trackingCommentId ?? 777,
      state: { head: "", findings: [] },
      skipReason: options.skipReason ?? lifecycleSkip,
      run: RUN,
    }));
    inputSpy = spyOn(reviewInput, "prepareReviewInput").mockResolvedValue({});
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
  });

  afterEach(() => {
    lifecycleSpy.mockRestore();
    inputSpy.mockRestore();
    setOutputSpy.mockRestore();
  });

  const context = () =>
    createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: { comment: { id: 101, body: "@droid review" } } as any,
      entityNumber: 24,
    });

  it("opens the lifecycle and leaves the input of the review it opened", async () => {
    const octokit = octokitFor(PULL_REQUEST);

    const result = await prepareReviewMode({
      context: context(),
      octokit,
      githubToken: "token",
      trackingCommentId: 555,
      fullReview: true,
      focus: "the migration for locking issues",
    });

    expect(lifecycleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha: "123abc",
        trackingCommentId: 555,
        full: true,
      }),
    );
    expect(inputSpy).toHaveBeenCalledTimes(1);
    expect(inputSpy.mock.calls[0]?.[0]).toMatchObject({
      octokit,
      githubToken: "token",
      run: RUN,
      pullRequest: {
        baseRefName: "main",
        headRefName: "feature/review",
        isFork: true,
        title: "PR for review",
        body: "Existing body",
      },
      focus: "the migration for locking issues",
    });
    expect(result).toEqual({
      commentId: 555,
      branchInfo: {
        baseBranch: "main",
        droidBranch: undefined,
        currentBranch: "feature/review",
      },
      mcpTools: "",
    });
    expect(setOutputSpy.mock.calls).toEqual([
      ["review_pr_number", "24"],
      ["droid_comment_id", "555"],
    ]);
  });

  it("leaves no input for a review the lifecycle skipped", async () => {
    lifecycleSkip = "Already reviewed this head.";

    const result = await prepareReviewMode({
      context: context(),
      octokit: octokitFor(PULL_REQUEST),
      githubToken: "token",
    });

    expect(inputSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      skipped: true,
      reason: "Already reviewed this head.",
      commentId: 777,
    });
    expect(setOutputSpy.mock.calls).toEqual([
      ["run_code_review", "false"],
      ["run_security_review", "false"],
      ["steward_skipped", "true"],
    ]);
  });

  it("skips the review when its input finds nothing new to review", async () => {
    inputSpy.mockResolvedValue({ skipReason: "No new changes." });

    const result = await prepareReviewMode({
      context: context(),
      octokit: octokitFor(PULL_REQUEST),
      githubToken: "token",
    });

    expect(result).toMatchObject({ skipped: true, reason: "No new changes." });
    expect(setOutputSpy.mock.calls).toEqual([
      ["run_code_review", "false"],
      ["run_security_review", "false"],
      ["steward_skipped", "true"],
    ]);
  });

  it("throws when invoked on non-PR context", async () => {
    await expect(
      prepareReviewMode({
        context: createMockContext({ isPR: false }),
        octokit: { rest: {}, graphql: () => {} } as any,
        githubToken: "token",
      }),
    ).rejects.toThrow("Review command is only supported on pull requests");
  });
});
