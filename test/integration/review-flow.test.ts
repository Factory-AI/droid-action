import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { prepareTagExecution } from "../../src/tag";
import { createMockContext } from "../mockContext";
import * as createInitial from "../../src/github/operations/comments/create-initial";
import * as mcpInstaller from "../../src/mcp/install-mcp-server";
import * as actorValidation from "../../src/github/validation/actor";
import * as promptModule from "../../src/create-prompt";
import * as reviewArtifactsModule from "../../src/github/data/review-artifacts";
import * as core from "@actions/core";
import * as childProcess from "node:child_process";
import { DroidRunType } from "../../src/run-type";

describe("review command integration", () => {
  const originalRunnerTemp = process.env.RUNNER_TEMP;
  const originalDroidArgs = process.env.DROID_ARGS;
  let tmpDir: string;
  let graphqlSpy: ReturnType<typeof spyOn>;
  let createCommentSpy: ReturnType<typeof spyOn>;
  let mcpSpy: ReturnType<typeof spyOn>;
  let actorSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let exportVarSpy: ReturnType<typeof spyOn>;
  let promptSpy: ReturnType<typeof spyOn>;
  let computeArtifactsSpy: ReturnType<typeof spyOn>;
  let execSyncSpy: ReturnType<typeof spyOn>;

  function createAutomaticReviewContext(automaticReview: boolean) {
    return createMockContext({
      eventName: "issue_comment",
      isPR: true,
      inputs: {
        automaticReview,
        automaticSecurityReview: true,
      },
      payload: {
        comment: {
          id: 888,
          body: "",
          user: { login: "human-reviewer" },
          created_at: "2024-02-02T00:00:00Z",
        },
        issue: {
          number: 7,
          pull_request: {},
        },
      } as any,
    });
  }

  function createAutomaticReviewOctokit(hasExistingSecurityReview: boolean) {
    const octokit = {
      rest: {
        issues: {
          listComments: () =>
            Promise.resolve({
              data: hasExistingSecurityReview
                ? [
                    {
                      user: { id: 209825114, login: "factory-droid[bot]" },
                      body: "## Security Review Summary",
                    },
                  ]
                : [],
            }),
        },
      },
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: {
              baseRefName: "main",
              headRefName: "feature/review",
              headRefOid: "def456",
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: "main",
          headRefName: "feature/review",
          headRefOid: "def456",
        },
      },
    });
    return octokit;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "review-int-"));
    process.env.RUNNER_TEMP = tmpDir;
    process.env.DROID_ARGS = "";

    createCommentSpy = spyOn(
      createInitial,
      "createInitialComment",
    ).mockResolvedValue({ id: 202 } as any);

    mcpSpy = spyOn(mcpInstaller, "prepareMcpTools").mockResolvedValue("{}");
    actorSpy = spyOn(actorValidation, "checkHumanActor").mockResolvedValue();
    promptSpy = spyOn(promptModule, "createPrompt").mockResolvedValue();
    computeArtifactsSpy = spyOn(
      reviewArtifactsModule,
      "computeReviewArtifacts",
    ).mockResolvedValue({
      diffPath: `${tmpDir}/droid-prompts/pr.diff`,
      commentsPath: `${tmpDir}/droid-prompts/existing_comments.json`,
      descriptionPath: `${tmpDir}/droid-prompts/pr_description.txt`,
    });
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    exportVarSpy = spyOn(core, "exportVariable").mockImplementation(() => {});

    execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
      cmd: string,
    ) => {
      if (cmd.includes("merge-base")) return "abc123def456\n";
      if (cmd.includes("git --no-pager diff")) {
        return "diff --git a/file.ts b/file.ts\n+added line\n";
      }
      return "";
    }) as typeof childProcess.execSync);
  });

  afterEach(async () => {
    graphqlSpy?.mockRestore();
    createCommentSpy.mockRestore();
    mcpSpy.mockRestore();
    actorSpy.mockRestore();
    promptSpy.mockRestore();
    computeArtifactsSpy.mockRestore();
    setOutputSpy.mockRestore();
    exportVarSpy.mockRestore();
    execSyncSpy.mockRestore();

    if (process.env.RUNNER_TEMP) {
      await rm(process.env.RUNNER_TEMP, { recursive: true, force: true });
    }

    if (originalRunnerTemp) {
      process.env.RUNNER_TEMP = originalRunnerTemp;
    } else {
      delete process.env.RUNNER_TEMP;
    }

    if (originalDroidArgs !== undefined) {
      process.env.DROID_ARGS = originalDroidArgs;
    } else {
      delete process.env.DROID_ARGS;
    }
  });

  it("prepares review flow end-to-end", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      actor: "human-reviewer",
      entityNumber: 7,
      repository: {
        owner: "test-owner",
        repo: "test-repo",
        full_name: "test-owner/test-repo",
      },
      payload: {
        comment: {
          id: 888,
          body: "@droid review",
          user: { login: "human-reviewer" },
          created_at: "2024-02-02T00:00:00Z",
        },
        issue: {
          number: 7,
          pull_request: {},
        },
      } as any,
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
              baseRefName: "main",
              headRefName: "feature/review",
              headRefOid: "def456",
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: "main",
          headRefName: "feature/review",
          headRefOid: "def456",
        },
      },
    });

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    expect(result.skipped).toBeFalsy();
    expect(result.branchInfo.baseBranch).toBe("main");
    expect(result.branchInfo.currentBranch).toBe("feature/review");
    expect(promptSpy).toHaveBeenCalled();
    expect(exportVarSpy).toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      DroidRunType.Review,
    );
    expect(createCommentSpy).toHaveBeenCalledWith(
      octokit.rest,
      context,
      "default",
      DroidRunType.Review,
    );

    // Verify output flags were set correctly for code review only
    const runCodeReviewCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "run_code_review",
    ) as [string, string] | undefined;
    const runSecurityReviewCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "run_security_review",
    ) as [string, string] | undefined;

    expect(runCodeReviewCall?.[1]).toBe("true");
    expect(runSecurityReviewCall?.[1]).toBe("false");
  });

  it("sets security flag only for @droid security", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      actor: "human-reviewer",
      entityNumber: 7,
      repository: {
        owner: "test-owner",
        repo: "test-repo",
        full_name: "test-owner/test-repo",
      },
      payload: {
        comment: {
          id: 888,
          body: "@droid security",
          user: { login: "human-reviewer" },
          created_at: "2024-02-02T00:00:00Z",
        },
        issue: {
          number: 7,
          pull_request: {},
        },
      } as any,
    });

    const octokit = {
      rest: {},
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: {
              baseRefName: "main",
              headRefName: "feature/security",
              headRefOid: "abc123",
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: "main",
          headRefName: "feature/security",
          headRefOid: "abc123",
        },
      },
    });

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    expect(result.skipped).toBeFalsy();
    expect(result.branchInfo.baseBranch).toBe("main");
    expect(result.branchInfo.currentBranch).toBe("feature/security");
    expect(promptSpy).toHaveBeenCalled();
    expect(exportVarSpy).toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      DroidRunType.SecurityReview,
    );
    expect(createCommentSpy).toHaveBeenCalledWith(
      octokit.rest,
      context,
      "security",
      DroidRunType.SecurityReview,
    );

    const runCodeReviewCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "run_code_review",
    ) as [string, string] | undefined;
    const runSecurityReviewCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "run_security_review",
    ) as [string, string] | undefined;

    // Standalone security now uses two-pass pipeline (candidates + validator)
    expect(runCodeReviewCall?.[1]).toBe("true");
    expect(runSecurityReviewCall?.[1]).toBe("true");
  });

  it("does not create a comment when automatic security review is skipped", async () => {
    const context = createAutomaticReviewContext(false);
    const octokit = createAutomaticReviewOctokit(true);

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    expect(result).toEqual({
      skipped: true,
      reason: "security_review_exists",
      branchInfo: {
        baseBranch: "",
        currentBranch: "",
      },
      mcpTools: "",
    });
    expect(createCommentSpy).not.toHaveBeenCalled();
    expect(setOutputSpy).toHaveBeenCalledWith("run_code_review", "false");
    expect(setOutputSpy).toHaveBeenCalledWith("run_security_review", "false");
  });

  it("creates a review-only comment when automatic security is skipped", async () => {
    const context = createAutomaticReviewContext(true);
    const octokit = createAutomaticReviewOctokit(true);

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    expect(result.skipped).toBeFalsy();
    expect(createCommentSpy).toHaveBeenCalledWith(
      octokit.rest,
      context,
      "default",
      DroidRunType.Review,
    );
    expect(setOutputSpy).toHaveBeenCalledWith("run_code_review", "true");
    expect(setOutputSpy).toHaveBeenCalledWith("run_security_review", "false");
    expect(exportVarSpy).not.toHaveBeenCalledWith(
      "SECURITY_REVIEW_ENABLED",
      "true",
    );
  });

  it("creates a combined comment when both automatic reviews will run", async () => {
    const context = createAutomaticReviewContext(true);
    const octokit = createAutomaticReviewOctokit(false);

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    expect(result.skipped).toBeFalsy();
    expect(createCommentSpy).toHaveBeenCalledWith(
      octokit.rest,
      context,
      "review_and_security",
      DroidRunType.Review,
    );
    expect(setOutputSpy).toHaveBeenCalledWith("run_code_review", "true");
    expect(setOutputSpy).toHaveBeenCalledWith("run_security_review", "true");
    expect(exportVarSpy).toHaveBeenCalledWith(
      "SECURITY_REVIEW_ENABLED",
      "true",
    );
  });
});
