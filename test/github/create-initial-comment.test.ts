import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import * as core from "@actions/core";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createInitialComment } from "../../src/github/operations/comments/create-initial";
import { DroidRunType } from "../../src/run-type";
import {
  createMockContext,
  mockPullRequestReviewCommentContext,
} from "../mockContext";
import {
  COMBINED_REVIEW_COMMENT_RUN_TYPE,
  createPrCommentMarker,
} from "../../src/github/operations/comments/common";

describe("createInitialComment", () => {
  const originalGitHubOutput = process.env.GITHUB_OUTPUT;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "droid-initial-comment-"));
    process.env.GITHUB_OUTPUT = join(tempDir, "github-output");
    spyOn(core, "exportVariable").mockImplementation(() => {});
  });

  afterEach(() => {
    mock.restore();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalGitHubOutput === undefined) {
      delete process.env.GITHUB_OUTPUT;
    } else {
      process.env.GITHUB_OUTPUT = originalGitHubOutput;
    }
  });

  it("records an inline tracking comment when the reply succeeds", async () => {
    const replyBodies: string[] = [];
    const octokit = {
      rest: {
        pulls: {
          createReplyForReviewComment: async ({ body }: { body: string }) => {
            replyBodies.push(body);
            return { data: { id: 123 } };
          },
        },
        issues: {
          createComment: async () => ({ data: { id: 456 } }),
        },
      },
    };

    await createInitialComment(
      octokit as any,
      mockPullRequestReviewCommentContext,
      "security",
      DroidRunType.SecurityReview,
    );

    expect(replyBodies[0]).toContain(
      "<!-- factory-pr-inline-comment: run-type=droid-security-review -->",
    );
    expect(core.exportVariable).toHaveBeenCalledWith(
      "DROID_PR_COMMENT_KIND",
      "inline-comment",
    );
  });

  it("records an issue tracking comment when the inline reply falls back", async () => {
    const issueBodies: string[] = [];
    const octokit = {
      rest: {
        pulls: {
          createReplyForReviewComment: async () => {
            throw new Error("reply failed");
          },
        },
        issues: {
          createComment: async ({ body }: { body: string }) => {
            issueBodies.push(body);
            return { data: { id: 456 } };
          },
        },
      },
    };

    await createInitialComment(
      octokit as any,
      mockPullRequestReviewCommentContext,
      "security",
      DroidRunType.SecurityReview,
    );

    expect(issueBodies[0]).toContain(
      "<!-- factory-pr-issue-comment: run-type=droid-security-review -->",
    );
    expect(core.exportVariable).toHaveBeenCalledWith(
      "DROID_PR_COMMENT_KIND",
      "issue-comment",
    );
  });

  it.each([
    [DroidRunType.Review, DroidRunType.SecurityReview],
    [DroidRunType.SecurityReview, DroidRunType.Review],
    [COMBINED_REVIEW_COMMENT_RUN_TYPE, DroidRunType.SecurityReview],
    [COMBINED_REVIEW_COMMENT_RUN_TYPE, DroidRunType.Review],
  ] as const)(
    "preserves both reviews when sticky %s is reused by %s",
    async (previous, current) => {
      const updateComment = mock(async (_params: unknown) => ({
        data: { id: 123 },
      }));
      const createComment = mock(async () => ({ data: { id: 456 } }));
      const octokit = {
        rest: {
          issues: {
            listComments: async () => ({
              data: [
                {
                  id: 123,
                  user: { id: 209825114 },
                  body: createPrCommentMarker("issue-comment", previous),
                },
              ],
            }),
            updateComment,
            createComment,
          },
        },
      };
      await createInitialComment(
        octokit as any,
        createMockContext({
          eventName: "pull_request",
          isPR: true,
          inputs: { useStickyComment: true },
        }),
        current === DroidRunType.SecurityReview ? "security" : "default",
        current,
      );
      expect(updateComment).toHaveBeenCalledWith(
        expect.objectContaining({
          comment_id: 123,
          body: expect.stringContaining(
            "<!-- factory-pr-issue-comment: run-type=droid-review-and-security -->",
          ),
        }),
      );
      expect(createComment).not.toHaveBeenCalled();
    },
  );

  it("creates a combined marker before either review updates the comment", async () => {
    const createComment = mock(async (_params: unknown) => ({
      data: { id: 123 },
    }));
    await createInitialComment(
      { rest: { issues: { createComment } } } as any,
      createMockContext({ eventName: "pull_request", isPR: true }),
      "review_and_security",
      DroidRunType.Review,
    );
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          "<!-- factory-pr-issue-comment: run-type=droid-review-and-security -->",
        ),
      }),
    );
  });
});
