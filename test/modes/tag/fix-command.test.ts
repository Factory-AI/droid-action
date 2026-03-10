import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import { prepareFixMode } from "../../../src/tag/commands/fix";
import { createMockContext } from "../../mockContext";
import * as prFetcher from "../../../src/github/data/pr-fetcher";
import * as promptModule from "../../../src/create-prompt";
import * as mcpInstaller from "../../../src/mcp/install-mcp-server";
import * as childProcess from "child_process";

const MOCK_PR_DATA = {
  title: "Test PR",
  body: "Existing description",
  baseRefName: "main",
  headRefName: "feature/branch",
  headRefOid: "abcdef",
};

describe("prepareFixMode", () => {
  const originalArgs = process.env.DROID_ARGS;
  const originalFixModel = process.env.FIX_MODEL;
  let fetchPRSpy: ReturnType<typeof spyOn>;
  let promptSpy: ReturnType<typeof spyOn>;
  let mcpSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let exportVariableSpy: ReturnType<typeof spyOn>;
  let execSyncSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.DROID_ARGS = "";
    delete process.env.FIX_MODEL;

    fetchPRSpy = spyOn(prFetcher, "fetchPRBranchData").mockResolvedValue({
      baseRefName: MOCK_PR_DATA.baseRefName,
      headRefName: MOCK_PR_DATA.headRefName,
      headRefOid: MOCK_PR_DATA.headRefOid,
      title: "Test PR",
      body: "Test description",
    });

    promptSpy = spyOn(promptModule, "createPrompt").mockResolvedValue();
    mcpSpy = spyOn(mcpInstaller, "prepareMcpTools").mockResolvedValue(
      "mock-config",
    );
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    exportVariableSpy = spyOn(core, "exportVariable").mockImplementation(
      () => {},
    );
    execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
      cmd: string,
    ) => {
      if (typeof cmd === "string" && cmd.includes("rev-parse")) {
        return "feature/branch\n";
      }
      return "";
    }) as typeof childProcess.execSync);
  });

  afterEach(() => {
    fetchPRSpy.mockRestore();
    promptSpy.mockRestore();
    mcpSpy.mockRestore();
    setOutputSpy.mockRestore();
    exportVariableSpy.mockRestore();
    execSyncSpy.mockRestore();
    process.env.DROID_ARGS = originalArgs;
    if (originalFixModel !== undefined) {
      process.env.FIX_MODEL = originalFixModel;
    } else {
      delete process.env.FIX_MODEL;
    }
  });

  it("prepares file-editing toolset and prompt for fix command", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 100,
          body: "@droid fix",
        },
      } as any,
      entityNumber: 42,
    });

    const octokit = { rest: {}, graphql: () => {} } as any;

    const result = await prepareFixMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 99,
    });

    expect(fetchPRSpy).toHaveBeenCalledWith({
      octokits: octokit,
      repository: context.repository,
      prNumber: 42,
    });
    expect(promptSpy).toHaveBeenCalled();
    expect(result.branchInfo.baseBranch).toBe("main");
    expect(result.branchInfo.currentBranch).toBe("feature/branch");
    expect(result.branchInfo.droidBranch).toBeUndefined();
    expect(result.commentId).toBe(99);

    // Verify allowed tools include file-editing tools
    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(droidArgsCall?.[1]).toContain("Edit");
    expect(droidArgsCall?.[1]).toContain("Create");
    expect(droidArgsCall?.[1]).toContain("ApplyPatch");
    expect(droidArgsCall?.[1]).toContain("Execute");
    expect(droidArgsCall?.[1]).toContain("FetchUrl");
    expect(droidArgsCall?.[1]).toContain('--tag "droid-fix"');

    expect(exportVariableSpy).toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      "droid-fix",
    );
  });

  it("throws when invoked on non-PR context", async () => {
    const context = createMockContext({ isPR: false });

    await expect(
      prepareFixMode({
        context,
        octokit: { rest: {}, graphql: () => {} } as any,
        githubToken: "token",
      }),
    ).rejects.toThrow("Fix command is only supported on pull requests");
  });

  it("adds --model flag when FIX_MODEL is set", async () => {
    process.env.FIX_MODEL = "gpt-5.1-codex";

    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 101,
          body: "@droid fix",
        },
      } as any,
      entityNumber: 43,
    });

    const octokit = { rest: {}, graphql: () => {} } as any;

    await prepareFixMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 100,
    });

    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(droidArgsCall?.[1]).toContain('--model "gpt-5.1-codex"');
  });

  it("does not add --model flag when FIX_MODEL is empty", async () => {
    process.env.FIX_MODEL = "";

    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 102,
          body: "@droid fix",
        },
      } as any,
      entityNumber: 44,
    });

    const octokit = { rest: {}, graphql: () => {} } as any;

    await prepareFixMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 101,
    });

    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(droidArgsCall?.[1]).not.toContain("--model");
  });

  it("passes fix context for pull_request_review_comment events", async () => {
    const context = createMockContext({
      eventName: "pull_request_review_comment",
      isPR: true,
      payload: {
        action: "created",
        comment: {
          id: 200,
          body: "@droid fix",
          path: "src/utils/algorithm.js",
          line: 42,
          in_reply_to_id: 199,
          created_at: "2024-01-01T00:00:00Z",
          user: { login: "reviewer", id: 123 },
        },
        pull_request: {
          number: 50,
          title: "Test PR",
          body: "",
          user: { login: "dev", id: 456 },
        },
      } as any,
      entityNumber: 50,
    });

    const mockGetReviewComment = async () => ({
      data: {
        body: "This function has a null pointer dereference bug",
        node_id: "node-1",
      },
    });

    const octokit = {
      rest: {
        pulls: {
          getReviewComment: mockGetReviewComment,
        },
      },
      graphql: () => {},
    } as any;

    await prepareFixMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 201,
    });

    // Verify createPrompt was called with fixContext
    const promptCall = promptSpy.mock.calls[0] as [any];
    expect(promptCall[0].fixContext).toEqual({
      parentCommentBody: "This function has a null pointer dereference bug",
      filePath: "src/utils/algorithm.js",
      line: 42,
    });
  });

  it("does not pass fix context for issue_comment events", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 300,
          body: "@droid fix all the things",
        },
      } as any,
      entityNumber: 60,
    });

    const octokit = { rest: {}, graphql: () => {} } as any;

    await prepareFixMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 301,
    });

    const promptCall = promptSpy.mock.calls[0] as [any];
    expect(promptCall[0].fixContext).toBeUndefined();
  });
});
