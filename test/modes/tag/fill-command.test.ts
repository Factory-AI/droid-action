import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import * as core from "@actions/core";
import { prepareFillMode } from "../../../src/tag/commands/fill";
import { createMockContext } from "../../mockContext";
import * as prFetcher from "../../../src/github/data/pr-fetcher";
import * as promptModule from "../../../src/create-prompt";
import * as mcpInstaller from "../../../src/mcp/install-mcp-server";

const MOCK_PR_DATA = {
  title: "Test PR",
  body: "Existing description",
  author: { login: "author" },
  baseRefName: "main",
  headRefName: "feature/branch",
  headRefOid: "abcdef",
  createdAt: "2024-01-01T00:00:00Z",
  additions: 10,
  deletions: 2,
  state: "OPEN",
  commits: { totalCount: 1, nodes: [] },
  files: { nodes: [] },
  comments: { nodes: [] },
  reviews: { nodes: [] },
} as any;

describe("prepareFillMode", () => {
  const originalArgs = process.env.DROID_ARGS;
  let fetchPRSpy: ReturnType<typeof spyOn>;
  let promptSpy: ReturnType<typeof spyOn>;
  let mcpSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let exportVariableSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.DROID_ARGS = "";

    fetchPRSpy = spyOn(prFetcher, "fetchPRBranchData").mockResolvedValue({
      baseRefName: MOCK_PR_DATA.baseRefName,
      headRefName: MOCK_PR_DATA.headRefName,
      headRefOid: MOCK_PR_DATA.headRefOid,
    });

    promptSpy = spyOn(promptModule, "createPrompt").mockResolvedValue();
    mcpSpy = spyOn(mcpInstaller, "prepareMcpTools").mockResolvedValue(
      "mock-config",
    );
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    exportVariableSpy = spyOn(core, "exportVariable").mockImplementation(
      () => {},
    );
  });

  afterEach(() => {
    fetchPRSpy.mockRestore();
    promptSpy.mockRestore();
    mcpSpy.mockRestore();
    setOutputSpy.mockRestore();
    exportVariableSpy.mockRestore();
    process.env.DROID_ARGS = originalArgs;
  });

  it("prepares limited toolset and prompt for fill command", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 100,
          body: "@droid fill please",
        },
      } as any,
      entityNumber: 42,
    });

    const octokit = { rest: {}, graphql: () => {} } as any;

    const result = await prepareFillMode({
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
    expect(mcpSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: expect.arrayContaining([
          "github_pr___update_pr_description",
        ]),
      }),
    );
    expect(result.branchInfo.baseBranch).toBe("main");
    expect(result.branchInfo.currentBranch).toBe("feature/branch");
    expect(result.branchInfo.droidBranch).toBeUndefined();
    expect(result.commentId).toBe(99);
    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(droidArgsCall?.[1]).toContain("github_pr___update_pr_description");
    expect(droidArgsCall?.[1]).toContain("Execute");
    expect(exportVariableSpy).toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      "droid-fill",
    );
  });

  it("throws when invoked on non-PR context", async () => {
    const context = createMockContext({ isPR: false });

    await expect(
      prepareFillMode({
        context,
        octokit: { rest: {}, graphql: () => {} } as any,
        githubToken: "token",
      }),
    ).rejects.toThrow("Fill command is only supported on pull requests");
  });
});
