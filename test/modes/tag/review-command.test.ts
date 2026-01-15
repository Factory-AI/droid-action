import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import { prepareReviewMode } from "../../../src/tag/commands/review";
import { createMockContext } from "../../mockContext";

import * as promptModule from "../../../src/create-prompt";
import * as mcpInstaller from "../../../src/mcp/install-mcp-server";
import * as comments from "../../../src/github/operations/comments/create-initial";
import * as childProcess from "child_process";
import * as fsPromises from "fs/promises";

const MOCK_PR_DATA = {
  title: "PR for review",
  body: "Existing body",
  author: { login: "author" },
  baseRefName: "main",
  headRefName: "feature/review",
  headRefOid: "123abc",
  createdAt: "2024-01-01T00:00:00Z",
  additions: 5,
  deletions: 1,
  state: "OPEN",
  commits: { totalCount: 1, nodes: [] },
  files: { nodes: [] },
  comments: { nodes: [] },
  reviews: { nodes: [] },
} as any;

describe("prepareReviewMode", () => {
  const originalArgs = process.env.DROID_ARGS;
  const originalReviewModel = process.env.REVIEW_MODEL;
  const originalRunnerTemp = process.env.RUNNER_TEMP;
  let graphqlSpy: ReturnType<typeof spyOn>;
  let promptSpy: ReturnType<typeof spyOn>;
  let mcpSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let createInitialSpy: ReturnType<typeof spyOn>;
  let exportVariableSpy: ReturnType<typeof spyOn>;
  let execSyncSpy: ReturnType<typeof spyOn>;
  let writeFileSpy: ReturnType<typeof spyOn>;
  let mkdirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.DROID_ARGS = "";
    delete process.env.REVIEW_MODEL;
    process.env.RUNNER_TEMP = "/tmp/test-runner";

    promptSpy = spyOn(promptModule, "createPrompt").mockResolvedValue();
    mcpSpy = spyOn(mcpInstaller, "prepareMcpTools").mockResolvedValue(
      "mock-config",
    );
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    createInitialSpy = spyOn(
      comments,
      "createInitialComment",
    ).mockResolvedValue({ id: 777 } as any);
    exportVariableSpy = spyOn(core, "exportVariable").mockImplementation(
      () => {},
    );
    // Mock execSync for git commands
    execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(
      ((cmd: string) => {
        if (cmd.includes("merge-base")) {
          return "abc123def456\n";
        }
        if (cmd.includes("diff")) {
          return "diff --git a/file.ts b/file.ts\n+added line\n";
        }
        return "";
      }) as typeof childProcess.execSync,
    );
    // Mock file system operations
    writeFileSpy = spyOn(fsPromises, "writeFile").mockResolvedValue();
    mkdirSpy = spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
  });

  afterEach(() => {
    graphqlSpy?.mockRestore();
    promptSpy.mockRestore();
    mcpSpy.mockRestore();
    setOutputSpy.mockRestore();
    createInitialSpy.mockRestore();
    exportVariableSpy.mockRestore();
    execSyncSpy.mockRestore();
    writeFileSpy.mockRestore();
    mkdirSpy.mockRestore();
    process.env.DROID_ARGS = originalArgs;
    if (originalReviewModel !== undefined) {
      process.env.REVIEW_MODEL = originalReviewModel;
    } else {
      delete process.env.REVIEW_MODEL;
    }
    if (originalRunnerTemp !== undefined) {
      process.env.RUNNER_TEMP = originalRunnerTemp;
    } else {
      delete process.env.RUNNER_TEMP;
    }
  });

  it("prepares review flow with limited toolset when tracking comment exists", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 101,
          body: "@droid review",
        },
      } as any,
      entityNumber: 24,
    });

    const octokit = {
      rest: {
        issues: {
          listComments: () => Promise.resolve({ data: [] }),
        },
        pulls: {
          listReviewComments: () => Promise.resolve({ data: [] }),
        },
      },
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: {
              baseRefName: MOCK_PR_DATA.baseRefName,
              headRefName: MOCK_PR_DATA.headRefName,
              headRefOid: MOCK_PR_DATA.headRefOid,
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: MOCK_PR_DATA.baseRefName,
          headRefName: MOCK_PR_DATA.headRefName,
          headRefOid: MOCK_PR_DATA.headRefOid,
        },
      },
    });

    const result = await prepareReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 555,
    });

    expect(graphqlSpy).toHaveBeenCalled();
    expect(promptSpy).toHaveBeenCalled();
    expect(mcpSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: expect.arrayContaining([
          "Execute",
          "github_comment___update_droid_comment",
          "github_inline_comment___create_inline_comment",
          "github_pr___list_review_comments",
          "github_pr___submit_review",
          "github_pr___resolve_review_thread",
        ]),
      }),
    );
    expect(createInitialSpy).not.toHaveBeenCalled();
    expect(result.commentId).toBe(555);
    expect(result.branchInfo.baseBranch).toBe("main");
    expect(result.branchInfo.currentBranch).toBe("feature/review");
    expect(result.branchInfo.droidBranch).toBeUndefined();
    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(droidArgsCall?.[1]).toContain("Execute");
    [
      "github_comment___update_droid_comment",
      "github_inline_comment___create_inline_comment",
      "github_pr___list_review_comments",
      "github_pr___submit_review",
      "github_pr___delete_comment",
      "github_pr___minimize_comment",
      "github_pr___reply_to_comment",
      "github_pr___resolve_review_thread",
    ].forEach((tool) => {
      expect(droidArgsCall?.[1]).toContain(tool);
    });
    expect(exportVariableSpy).toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      "droid-review",
    );
  });

  it("creates tracking comment when not provided", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 102,
          body: "@droid review now",
        },
      } as any,
      entityNumber: 25,
    });

    const octokit = {
      rest: {
        issues: {
          listComments: () => Promise.resolve({ data: [] }),
        },
        pulls: {
          listReviewComments: () => Promise.resolve({ data: [] }),
        },
      },
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: {
              baseRefName: MOCK_PR_DATA.baseRefName,
              headRefName: MOCK_PR_DATA.headRefName,
              headRefOid: MOCK_PR_DATA.headRefOid,
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: MOCK_PR_DATA.baseRefName,
          headRefName: MOCK_PR_DATA.headRefName,
          headRefOid: MOCK_PR_DATA.headRefOid,
        },
      },
    });

    const result = await prepareReviewMode({
      context,
      octokit,
      githubToken: "token",
    });

    expect(createInitialSpy).toHaveBeenCalled();
    expect(result.commentId).toBe(777);
  });

  it("throws when invoked on non-PR context", async () => {
    const context = createMockContext({ isPR: false });

    await expect(
      prepareReviewMode({
        context,
        octokit: { rest: {}, graphql: () => {} } as any,
        githubToken: "token",
      }),
    ).rejects.toThrow("Review command is only supported on pull requests");
  });

  it("adds --model flag when REVIEW_MODEL is set", async () => {
    process.env.REVIEW_MODEL = "claude-sonnet-4-5-20250929";

    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 103,
          body: "@droid review",
        },
      } as any,
      entityNumber: 26,
    });

    const octokit = {
      rest: {
        issues: {
          listComments: () => Promise.resolve({ data: [] }),
        },
        pulls: {
          listReviewComments: () => Promise.resolve({ data: [] }),
        },
      },
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: {
              baseRefName: MOCK_PR_DATA.baseRefName,
              headRefName: MOCK_PR_DATA.headRefName,
              headRefOid: MOCK_PR_DATA.headRefOid,
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: MOCK_PR_DATA.baseRefName,
          headRefName: MOCK_PR_DATA.headRefName,
          headRefOid: MOCK_PR_DATA.headRefOid,
        },
      },
    });

    await prepareReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 556,
    });

    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(droidArgsCall?.[1]).toContain(
      '--model "claude-sonnet-4-5-20250929"',
    );
  });

  it("does not add --model flag when REVIEW_MODEL is empty", async () => {
    process.env.REVIEW_MODEL = "";
    delete process.env.REASONING_EFFORT;

    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 104,
          body: "@droid review",
        },
      } as any,
      entityNumber: 27,
    });

    const octokit = {
      rest: {
        issues: {
          listComments: () => Promise.resolve({ data: [] }),
        },
        pulls: {
          listReviewComments: () => Promise.resolve({ data: [] }),
        },
      },
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: {
              baseRefName: MOCK_PR_DATA.baseRefName,
              headRefName: MOCK_PR_DATA.headRefName,
              headRefOid: MOCK_PR_DATA.headRefOid,
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: MOCK_PR_DATA.baseRefName,
          headRefName: MOCK_PR_DATA.headRefName,
          headRefOid: MOCK_PR_DATA.headRefOid,
        },
      },
    });

    await prepareReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 557,
    });

    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    // When neither REVIEW_MODEL nor REASONING_EFFORT is provided, we default to gpt-5.2 at xhigh reasoning.
    expect(droidArgsCall?.[1]).toContain('--model "gpt-5.2"');
    expect(droidArgsCall?.[1]).toContain('--reasoning-effort "xhigh"');
  });
});
