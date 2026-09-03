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
import { mockPullRequestReviewCommentContext } from "../mockContext";

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
});
