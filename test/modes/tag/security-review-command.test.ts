import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import { prepareSecurityReviewMode } from "../../../src/tag/commands/security-review";
import { createMockContext } from "../../mockContext";
import * as reviewInput from "../../../src/github/data/review-input";
import * as lifecycle from "../../../src/github/operations/review-lifecycle";

const RUN = { head: "123abc" } as lifecycle.ReviewLifecycleRun;

const octokit = {
  graphql: () =>
    Promise.resolve({
      repository: {
        pullRequest: {
          baseRefName: "main",
          headRefName: "feature/security",
          headRefOid: "123abc",
          isCrossRepository: false,
          title: "PR for security review",
          body: "Existing body",
        },
      },
    }),
} as any;

describe("prepareSecurityReviewMode", () => {
  let lifecycleSpy: ReturnType<typeof spyOn>;
  let inputSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    lifecycleSpy = spyOn(
      lifecycle,
      "prepareReviewLifecycle",
    ).mockImplementation(async (options) => ({
      commentId: options.trackingCommentId ?? 777,
      state: { head: "", findings: [] },
      skipReason: options.skipReason ?? undefined,
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
      payload: { comment: { id: 101, body: "@droid security" } } as any,
      entityNumber: 24,
    });

  it("opens a security-only lifecycle and leaves the input of the review it opened", async () => {
    const result = await prepareSecurityReviewMode({
      context: context(),
      octokit,
      githubToken: "token",
      trackingCommentId: 555,
    });

    expect(lifecycleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha: "123abc",
        trackingCommentId: 555,
        securityOnly: true,
        // A person asked for it, so the whole change is reviewed.
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
        headRefName: "feature/security",
        isFork: false,
        title: "PR for security review",
      },
    });
    expect(inputSpy.mock.calls[0]?.[0].focus).toBeUndefined();
    expect(result).toMatchObject({ commentId: 555, mcpTools: "" });
    expect(setOutputSpy.mock.calls).toEqual([
      ["review_pr_number", "24"],
      ["droid_comment_id", "555"],
    ]);
  });

  it("leaves no input for a review its caller found already done", async () => {
    const result = await prepareSecurityReviewMode({
      context: context(),
      octokit,
      githubToken: "token",
      skipReason: "Security review already ran for this head.",
    });

    expect(inputSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      skipped: true,
      reason: "Security review already ran for this head.",
      commentId: 777,
    });
    expect(setOutputSpy.mock.calls).toEqual([
      ["run_code_review", "false"],
      ["run_security_review", "false"],
      ["steward_skipped", "true"],
    ]);
  });

  it("throws when invoked on non-PR context", async () => {
    await expect(
      prepareSecurityReviewMode({
        context: createMockContext({ isPR: false }),
        octokit: { rest: {}, graphql: () => {} } as any,
        githubToken: "token",
      }),
    ).rejects.toThrow(
      "Security review command is only supported on pull requests",
    );
  });
});
