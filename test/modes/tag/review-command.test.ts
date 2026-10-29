import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import { prepareReviewMode } from "../../../src/tag/commands/review";
import { createMockContext } from "../../mockContext";

import * as promptModule from "../../../src/create-prompt";
import * as mcpInstaller from "../../../src/mcp/install-mcp-server";
import * as comments from "../../../src/github/operations/comments/create-initial";
import * as childProcess from "child_process";
import * as fsPromises from "fs/promises";
import { DroidRunType } from "../../../src/run-type";
import { parseSessionTagFromDroidArgs } from "../../utils/session-tag-helpers";
import * as lifecycle from "../../../src/github/operations/review-lifecycle";

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
  const originalSecurityReviewEnabled = process.env.SECURITY_REVIEW_ENABLED;
  const originalFactoryApiKey = process.env.FACTORY_API_KEY;
  const originalReasoningEffort = process.env.REASONING_EFFORT;
  let graphqlSpy: ReturnType<typeof spyOn>;
  let promptSpy: ReturnType<typeof spyOn>;
  let mcpSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let createInitialSpy: ReturnType<typeof spyOn>;
  let exportVariableSpy: ReturnType<typeof spyOn>;
  let execSyncSpy: ReturnType<typeof spyOn>;
  let writeFileSpy: ReturnType<typeof spyOn>;
  let mkdirSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;
  let lifecycleSpy: ReturnType<typeof spyOn>;
  let readLifecycleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    lifecycleSpy = spyOn(
      lifecycle,
      "prepareReviewLifecycle",
    ).mockImplementation(async (options) => ({
      commentId: options.trackingCommentId ?? 777,
      state: { head: "", findings: [] },
      run: {} as lifecycle.ReviewLifecycleRun,
    }));
    readLifecycleSpy = spyOn(
      lifecycle,
      "readReviewLifecycle",
    ).mockResolvedValue(null);
    process.env.DROID_ARGS = "";
    delete process.env.REVIEW_MODEL;
    delete process.env.SECURITY_REVIEW_ENABLED;
    process.env.RUNNER_TEMP = "/tmp/test-runner";
    process.env.FACTORY_API_KEY = "test-factory-api-key";
    // Exercise policy parsing without network timing or runner credentials.
    const policyFetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        expect(String(input)).toEndWith("/api/organization/managed-settings");
        return Response.json({ success: true, settings: {} });
      },
      { preconnect: fetch.preconnect },
    );
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(policyFetch);

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
    execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
      cmd: string,
    ) => {
      if (cmd.includes("merge-base")) {
        return "abc123def456\n";
      }
      if (cmd.includes("diff")) {
        return "diff --git a/file.ts b/file.ts\n+added line\n";
      }
      return "";
    }) as typeof childProcess.execSync);
    // Mock file system operations
    writeFileSpy = spyOn(fsPromises, "writeFile").mockResolvedValue();
    mkdirSpy = spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
  });

  afterEach(() => {
    lifecycleSpy.mockRestore();
    readLifecycleSpy.mockRestore();
    fetchSpy?.mockRestore();
    graphqlSpy?.mockRestore();
    promptSpy.mockRestore();
    mcpSpy.mockRestore();
    setOutputSpy.mockRestore();
    createInitialSpy.mockRestore();
    exportVariableSpy.mockRestore();
    execSyncSpy.mockRestore();
    writeFileSpy.mockRestore();
    mkdirSpy.mockRestore();
    if (originalArgs === undefined) {
      delete process.env.DROID_ARGS;
    } else {
      process.env.DROID_ARGS = originalArgs;
    }
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
    if (originalSecurityReviewEnabled !== undefined) {
      process.env.SECURITY_REVIEW_ENABLED = originalSecurityReviewEnabled;
    } else {
      delete process.env.SECURITY_REVIEW_ENABLED;
    }
    for (const [name, value] of Object.entries({
      FACTORY_API_KEY: originalFactoryApiKey,
      REASONING_EFFORT: originalReasoningEffort,
    })) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
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
              isCrossRepository: false,
              title: MOCK_PR_DATA.title,
              body: MOCK_PR_DATA.body,
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
          isCrossRepository: false,
          title: MOCK_PR_DATA.title,
          body: MOCK_PR_DATA.body,
        },
      },
    });

    const result = await prepareReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 555,
      fullReview: true,
      focus: "the migration for locking issues",
    });

    expect(graphqlSpy).toHaveBeenCalled();
    expect(promptSpy).toHaveBeenCalled();
    expect(lifecycleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ full: true }),
    );
    const generated = promptSpy.mock.calls[0]?.[0]?.generatePrompt(
      promptModule.prepareContext(context),
    );
    expect(generated).toContain("the migration for locking issues");
    expect(mcpSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runType: DroidRunType.Review,
        allowedTools: expect.arrayContaining([
          "Execute",
          "github_comment___update_droid_comment",
          "Task",
          "FetchUrl",
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
    expect(droidArgsCall?.[1]).toContain("Task");
    expect(droidArgsCall?.[1]).toContain("FetchUrl");
    expect(droidArgsCall?.[1]).toContain(
      "github_comment___update_droid_comment",
    );
    // Candidate generation phase should NOT have PR mutation tools
    expect(droidArgsCall?.[1]).not.toContain(
      "github_inline_comment___create_inline_comment",
    );
    expect(droidArgsCall?.[1]).not.toContain("github_pr___submit_review");
    expect(parseSessionTagFromDroidArgs(droidArgsCall?.[1] ?? "")).toEqual({
      name: "code-review",
      metadata: expect.objectContaining({
        pass: "candidates",
        reviewType: "code",
        platform: "github",
        repo: "test-owner/test-repo",
        pr: "24",
        securityReview: "false",
        runId: "1234567890",
      }),
    });
  });

  it("checks out a same-repository PR", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: { comment: { id: 103, body: "@droid review" } } as any,
      entityNumber: 26,
    });
    const octokit = {
      rest: {
        issues: { listComments: () => Promise.resolve({ data: [] }) },
        pulls: { listReviewComments: () => Promise.resolve({ data: [] }) },
      },
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: { ...MOCK_PR_DATA, isCrossRepository: false },
          },
        }),
    } as any;

    await prepareReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 555,
    });

    const commands = execSyncSpy.mock.calls.map((call: unknown[]) =>
      String(call[0]),
    );
    expect(commands).toContain("gh pr checkout 26");
    expect(commands.some((cmd: string) => cmd.includes("refs/pull/"))).toBe(
      false,
    );
    expect(promptSpy.mock.calls[0]?.[0]?.prBranchData).toMatchObject({
      isFork: false,
      headRevision: "HEAD",
    });
  });

  // The job holds the workflow's secrets, and a checked-out fork could plant
  // files that tools in the job load and run (bunfig.toml, .env, .factory).
  it("never checks out a fork PR and diffs its fetched head instead", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: { comment: { id: 104, body: "@droid review" } } as any,
      entityNumber: 27,
    });
    const octokit = {
      rest: {
        issues: { listComments: () => Promise.resolve({ data: [] }) },
        pulls: { listReviewComments: () => Promise.resolve({ data: [] }) },
      },
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: { ...MOCK_PR_DATA, isCrossRepository: true },
          },
        }),
    } as any;

    await prepareReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 555,
    });

    const commands = execSyncSpy.mock.calls.map((call: unknown[]) =>
      String(call[0]),
    );
    expect(
      commands.some(
        (cmd: string) =>
          cmd.includes("gh pr checkout") ||
          cmd.includes("git reset") ||
          /git (checkout|switch)\b/.test(cmd),
      ),
    ).toBe(false);
    const forkRef = "refs/remotes/droid/pr-27-head";
    expect(
      commands.some((cmd: string) =>
        cmd.endsWith(`fetch --no-tags origin +refs/pull/27/head:${forkRef}`),
      ),
    ).toBe(true);
    expect(commands).toContain(
      `git merge-base ${forkRef} refs/remotes/origin/main`,
    );
    expect(commands).toContain(`git --no-pager diff abc123def456..${forkRef}`);
    expect(promptSpy.mock.calls[0]?.[0]?.prBranchData).toMatchObject({
      isFork: true,
      headRevision: forkRef,
    });
  });

  it("falls back to the API diff when a fork PR's commits cannot be fetched", async () => {
    execSyncSpy.mockImplementation(((cmd: string) => {
      if (cmd.includes("refs/pull/")) throw new Error("fetch failed");
      if (cmd.startsWith("gh pr diff")) return "diff from api\n";
      return "";
    }) as typeof childProcess.execSync);
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: { comment: { id: 105, body: "@droid review" } } as any,
      entityNumber: 28,
    });
    const octokit = {
      rest: {
        issues: { listComments: () => Promise.resolve({ data: [] }) },
        pulls: { listReviewComments: () => Promise.resolve({ data: [] }) },
      },
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: { ...MOCK_PR_DATA, isCrossRepository: true },
          },
        }),
    } as any;

    await prepareReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 555,
    });

    const commands = execSyncSpy.mock.calls.map((call: unknown[]) =>
      String(call[0]),
    );
    expect(commands).toContain("gh pr diff 28");
    expect(commands.some((cmd: string) => cmd.includes("merge-base"))).toBe(
      false,
    );
    expect(promptSpy.mock.calls[0]?.[0]?.prBranchData).toMatchObject({
      isFork: true,
      headRevision: null,
    });
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
              isCrossRepository: false,
              title: MOCK_PR_DATA.title,
              body: MOCK_PR_DATA.body,
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
          isCrossRepository: false,
          title: MOCK_PR_DATA.title,
          body: MOCK_PR_DATA.body,
        },
      },
    });

    const result = await prepareReviewMode({
      context,
      octokit,
      githubToken: "token",
    });

    expect(lifecycleSpy).toHaveBeenCalledWith(
      expect.objectContaining({ octokit, context }),
    );
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
              isCrossRepository: false,
              title: MOCK_PR_DATA.title,
              body: MOCK_PR_DATA.body,
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
          isCrossRepository: false,
          title: MOCK_PR_DATA.title,
          body: MOCK_PR_DATA.body,
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
    expect(setOutputSpy).toHaveBeenCalledWith(
      "review_model",
      "claude-sonnet-4-5-20250929",
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
              isCrossRepository: false,
              title: MOCK_PR_DATA.title,
              body: MOCK_PR_DATA.body,
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
          isCrossRepository: false,
          title: MOCK_PR_DATA.title,
          body: MOCK_PR_DATA.body,
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
    // When REVIEW_MODEL is empty the deep depth preset kicks in (openai-latest-balanced, medium reasoning).
    expect(droidArgsCall?.[1]).toContain('--model "openai-latest-balanced"');
    expect(droidArgsCall?.[1]).toContain('--reasoning-effort "medium"');
    expect(setOutputSpy).toHaveBeenCalledWith(
      "review_model",
      "openai-latest-balanced",
    );
    expect(setOutputSpy).toHaveBeenCalledWith(
      "review_reasoning_effort",
      "medium",
    );
  });

  it("stores PR description as an artifact file", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 105,
          body: "@droid review",
        },
      } as any,
      entityNumber: 28,
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
      graphql: () => Promise.resolve({}),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: MOCK_PR_DATA.baseRefName,
          headRefName: MOCK_PR_DATA.headRefName,
          headRefOid: MOCK_PR_DATA.headRefOid,
          isCrossRepository: false,
          title: "Add new feature",
          body: "This PR adds a new feature\n\nFixes: https://linear.app/team/PROJ-123",
        },
      },
    });

    await prepareReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 558,
    });

    const descriptionWriteCall = writeFileSpy.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("pr_description.txt"),
    );
    expect(descriptionWriteCall).toBeDefined();
    expect(descriptionWriteCall![1]).toContain("# Add new feature");
    expect(descriptionWriteCall![1]).toContain(
      "This PR adds a new feature\n\nFixes: https://linear.app/team/PROJ-123",
    );
  });

  it("stores empty description when PR body is null", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 106,
          body: "@droid review",
        },
      } as any,
      entityNumber: 29,
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
      graphql: () => Promise.resolve({}),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: MOCK_PR_DATA.baseRefName,
          headRefName: MOCK_PR_DATA.headRefName,
          headRefOid: MOCK_PR_DATA.headRefOid,
          isCrossRepository: false,
          title: "Quick fix",
          body: null,
        },
      },
    });

    await prepareReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 559,
    });

    const descriptionWriteCall = writeFileSpy.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "string" &&
        (call[0] as string).includes("pr_description.txt"),
    );
    expect(descriptionWriteCall).toBeDefined();
    expect(descriptionWriteCall![1]).toContain("# Quick fix");
    expect(descriptionWriteCall![1]).not.toContain("null");
  });

  it("passes description artifact to createPrompt", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 107,
          body: "@droid review",
        },
      } as any,
      entityNumber: 30,
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
      graphql: () => Promise.resolve({}),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: MOCK_PR_DATA.baseRefName,
          headRefName: MOCK_PR_DATA.headRefName,
          headRefOid: MOCK_PR_DATA.headRefOid,
          isCrossRepository: false,
          title: MOCK_PR_DATA.title,
          body: MOCK_PR_DATA.body,
        },
      },
    });

    await prepareReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 560,
    });

    expect(promptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewArtifacts: expect.objectContaining({
          descriptionPath: expect.stringContaining("pr_description.txt"),
        }),
      }),
    );
  });

  it("always includes Task and FetchUrl in allowed tools for candidate generation", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: {
        comment: {
          id: 108,
          body: "@droid review",
        },
      } as any,
      entityNumber: 31,
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
      graphql: () => Promise.resolve({}),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: MOCK_PR_DATA.baseRefName,
          headRefName: MOCK_PR_DATA.headRefName,
          headRefOid: MOCK_PR_DATA.headRefOid,
          isCrossRepository: false,
          title: MOCK_PR_DATA.title,
          body: MOCK_PR_DATA.body,
        },
      },
    });

    await prepareReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 561,
    });

    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(droidArgsCall?.[1]).toContain("FetchUrl");
    expect(droidArgsCall?.[1]).toContain("Task");
  });
});
