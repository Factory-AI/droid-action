import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
  mock,
} from "bun:test";
import * as core from "@actions/core";
import { prepareSecurityReviewMode } from "../../../src/tag/commands/security-review";
import { createMockContext } from "../../mockContext";

import * as prFetcher from "../../../src/github/data/pr-fetcher";
import * as reviewArtifacts from "../../../src/github/data/review-artifacts";
import * as promptModule from "../../../src/create-prompt";
import * as mcpInstaller from "../../../src/mcp/install-mcp-server";
import * as comments from "../../../src/github/operations/comments/create-initial";

const MOCK_PR_DATA = {
  baseRefName: "main",
  headRefName: "feature/security-review",
  headRefOid: "123abc",
} as const;

const MOCK_REVIEW_ARTIFACTS = {
  diffPath: "/tmp/droid-prompts/pr.diff",
  commentsPath: "/tmp/droid-prompts/existing_comments.json",
  descriptionPath: "/tmp/droid-prompts/pr_description.txt",
};

describe("prepareSecurityReviewMode", () => {
  const originalArgs = process.env.DROID_ARGS;
  const originalReviewModel = process.env.REVIEW_MODEL;
  const originalSecurityModel = process.env.SECURITY_MODEL;
  let fetchPRSpy: ReturnType<typeof spyOn>;
  let computeArtifactsSpy: ReturnType<typeof spyOn>;
  let promptSpy: ReturnType<typeof spyOn>;
  let mcpSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let createInitialSpy: ReturnType<typeof spyOn>;
  let exportVariableSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.DROID_ARGS = "";
    delete process.env.REVIEW_MODEL;
    delete process.env.SECURITY_MODEL;

    fetchPRSpy = spyOn(prFetcher, "fetchPRBranchData").mockResolvedValue({
      baseRefName: MOCK_PR_DATA.baseRefName,
      headRefName: MOCK_PR_DATA.headRefName,
      headRefOid: MOCK_PR_DATA.headRefOid,
      title: "Test PR",
      body: "Test description",
    });

    computeArtifactsSpy = spyOn(
      reviewArtifacts,
      "computeReviewArtifacts",
    ).mockResolvedValue(MOCK_REVIEW_ARTIFACTS);

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

    // Mock execSync for git checkout
    mock.module("child_process", () => ({
      execSync: (cmd: string) => {
        if (cmd.includes("git rev-parse")) return "feature/security-review\n";
        return "";
      },
    }));
  });

  afterEach(() => {
    fetchPRSpy.mockRestore();
    computeArtifactsSpy.mockRestore();
    promptSpy.mockRestore();
    mcpSpy.mockRestore();
    setOutputSpy.mockRestore();
    createInitialSpy.mockRestore();
    exportVariableSpy.mockRestore();

    process.env.DROID_ARGS = originalArgs;
    if (originalReviewModel !== undefined) {
      process.env.REVIEW_MODEL = originalReviewModel;
    } else {
      delete process.env.REVIEW_MODEL;
    }
    if (originalSecurityModel !== undefined) {
      process.env.SECURITY_MODEL = originalSecurityModel;
    } else {
      delete process.env.SECURITY_MODEL;
    }
  });

  it("prepares security review flow with candidate generation toolset", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 101,
          body: "@droid security-review",
        },
      } as any,
      entityNumber: 24,
    });

    const octokit = { rest: {}, graphql: () => {} } as any;

    const result = await prepareSecurityReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 555,
    });

    expect(fetchPRSpy).toHaveBeenCalledWith({
      octokits: octokit,
      repository: context.repository,
      prNumber: 24,
    });
    expect(promptSpy).toHaveBeenCalled();
    expect(mcpSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: expect.arrayContaining([
          "Execute",
          "Task",
          "Skill",
          "github_comment___update_droid_comment",
        ]),
      }),
    );
    // Should NOT include inline comment or direct review tools (validator handles posting)
    const mcpCall = mcpSpy.mock.calls[0] as any[];
    const allowedTools = mcpCall[0].allowedTools as string[];
    expect(allowedTools).not.toContain(
      "github_inline_comment___create_inline_comment",
    );
    expect(allowedTools).not.toContain("github_pr___submit_review");

    expect(createInitialSpy).not.toHaveBeenCalled();
    expect(result.commentId).toBe(555);
    expect(result.branchInfo.baseBranch).toBe("main");
    expect(result.branchInfo.currentBranch).toBe("feature/security-review");
    expect(result.branchInfo.droidBranch).toBeUndefined();

    expect(exportVariableSpy).toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      "droid-security-review",
    );
  });

  it("creates tracking comment when not provided", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 102,
          body: "@droid security-review",
        },
      } as any,
      entityNumber: 25,
    });

    const octokit = { rest: {}, graphql: () => {} } as any;

    const result = await prepareSecurityReviewMode({
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
      prepareSecurityReviewMode({
        context,
        octokit: { rest: {}, graphql: () => {} } as any,
        githubToken: "token",
      }),
    ).rejects.toThrow(
      "Security review command is only supported on pull requests",
    );
  });

  it("adds --model flag when REVIEW_MODEL is set", async () => {
    process.env.REVIEW_MODEL = "claude-sonnet-4-5-20250929";

    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 103,
          body: "@droid security-review",
        },
      } as any,
      entityNumber: 26,
    });

    const octokit = { rest: {}, graphql: () => {} } as any;

    await prepareSecurityReviewMode({
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

    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 104,
          body: "@droid security-review",
        },
      } as any,
      entityNumber: 27,
    });

    const octokit = { rest: {}, graphql: () => {} } as any;

    await prepareSecurityReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 557,
    });

    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(droidArgsCall?.[1]).not.toContain("--model");
  });

  it("outputs install_security_skills flag", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 105,
          body: "@droid security-review",
        },
      } as any,
      entityNumber: 28,
    });

    const octokit = { rest: {}, graphql: () => {} } as any;

    await prepareSecurityReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 558,
    });

    const installSkillsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "install_security_skills",
    ) as [string, string] | undefined;
    expect(installSkillsCall?.[1]).toBe("true");
  });

  it("prefers SECURITY_MODEL over REVIEW_MODEL", async () => {
    process.env.SECURITY_MODEL = "gpt-5.1-codex";
    process.env.REVIEW_MODEL = "claude-sonnet-4-5-20250929";

    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 106,
          body: "@droid security-review",
        },
      } as any,
      entityNumber: 29,
    });

    const octokit = { rest: {}, graphql: () => {} } as any;

    await prepareSecurityReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 559,
    });

    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(droidArgsCall?.[1]).toContain('--model "gpt-5.1-codex"');
    expect(droidArgsCall?.[1]).not.toContain("claude-sonnet");
  });

  it("falls back to REVIEW_MODEL when SECURITY_MODEL is not set", async () => {
    process.env.REVIEW_MODEL = "claude-sonnet-4-5-20250929";

    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 107,
          body: "@droid security-review",
        },
      } as any,
      entityNumber: 30,
    });

    const octokit = { rest: {}, graphql: () => {} } as any;

    await prepareSecurityReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 560,
    });

    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(droidArgsCall?.[1]).toContain(
      '--model "claude-sonnet-4-5-20250929"',
    );
  });

  it("outputs review_pr_number and droid_comment_id", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 108,
          body: "@droid security-review",
        },
      } as any,
      entityNumber: 31,
    });

    const octokit = { rest: {}, graphql: () => {} } as any;

    await prepareSecurityReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 561,
    });

    const prNumberCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "review_pr_number",
    ) as [string, string] | undefined;
    expect(prNumberCall?.[1]).toBe("31");

    const commentIdCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_comment_id",
    ) as [string, string] | undefined;
    expect(commentIdCall?.[1]).toBe("561");
  });
});
