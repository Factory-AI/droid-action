import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { prepareTagExecution } from "../../src/tag";
import { createMockContext } from "../mockContext";
import * as createInitial from "../../src/github/operations/comments/create-initial";
import * as mcpInstaller from "../../src/mcp/install-mcp-server";
import * as actorValidation from "../../src/github/validation/actor";
import * as core from "@actions/core";
import * as childProcess from "node:child_process";

describe("fix command integration", () => {
  const originalRunnerTemp = process.env.RUNNER_TEMP;
  const originalDroidArgs = process.env.DROID_ARGS;
  let tmpDir: string;
  let graphqlSpy: ReturnType<typeof spyOn>;
  let createCommentSpy: ReturnType<typeof spyOn>;
  let mcpSpy: ReturnType<typeof spyOn>;
  let actorSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let exportVarSpy: ReturnType<typeof spyOn>;
  let execSyncSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fix-int-"));
    process.env.RUNNER_TEMP = tmpDir;
    process.env.DROID_ARGS = "";

    createCommentSpy = spyOn(
      createInitial,
      "createInitialComment",
    ).mockResolvedValue({ id: 301 } as any);

    mcpSpy = spyOn(mcpInstaller, "prepareMcpTools").mockResolvedValue("{}");
    actorSpy = spyOn(actorValidation, "checkHumanActor").mockResolvedValue();
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    exportVarSpy = spyOn(core, "exportVariable").mockImplementation(() => {});
    execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
      cmd: string,
    ) => {
      if (cmd.includes("rev-parse")) return "feature/fix-branch\n";
      return "";
    }) as typeof childProcess.execSync);
  });

  afterEach(async () => {
    graphqlSpy?.mockRestore();
    createCommentSpy.mockRestore();
    mcpSpy.mockRestore();
    actorSpy.mockRestore();
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

  it("prepares top-level fix flow end-to-end via @droid fix on PR comment", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      actor: "human-user",
      entityNumber: 10889,
      repository: {
        owner: "Factory-AI",
        repo: "factory-mono",
        full_name: "Factory-AI/factory-mono",
      },
      payload: {
        comment: {
          id: 555,
          body: "@droid fix",
          user: { login: "reviewer" },
          created_at: "2024-01-02T00:00:00Z",
        },
        issue: {
          number: 10889,
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
              baseRefName: "dev",
              headRefName: "ci-fail-review-test",
              headRefOid: "55cf61f",
              title: "[TEST] CI failure review validation",
              body: "Test PR with intentional type error",
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: "dev",
          headRefName: "ci-fail-review-test",
          headRefOid: "55cf61f",
          title: "[TEST] CI failure review validation",
          body: "Test PR with intentional type error",
        },
      },
    });

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    // Verify the fix flow was selected (not review, fill, etc.)
    expect(exportVarSpy).toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      "droid-fix",
    );
    expect(result.commentId).toBe(301);
    expect(result.branchInfo.baseBranch).toBe("dev");
    expect(result.branchInfo.currentBranch).toBe("ci-fail-review-test");

    // Verify output flags: no code review, no security review
    const runCodeReview = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "run_code_review",
    ) as [string, string] | undefined;
    const runSecurityReview = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "run_security_review",
    ) as [string, string] | undefined;
    expect(runCodeReview?.[1]).toBe("false");
    expect(runSecurityReview?.[1]).toBe("false");

    // Verify prompt was written to disk
    const promptPath = path.join(
      tmpDir,
      "droid-prompts",
      "droid-prompt.txt",
    );
    const prompt = await readFile(promptPath, "utf8");

    // Top-level fix: should instruct to fix all review findings
    expect(prompt).toContain("PR #10889");
    expect(prompt).toContain("Factory-AI/factory-mono");
    expect(prompt).toContain("gh pr diff 10889");
    expect(prompt).toContain("Identify issues to fix");
    expect(prompt).toContain("git commit");
    expect(prompt).toContain("git push");

    // Verify droid_args include file-editing tools and fix tag
    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(droidArgsCall?.[1]).toContain("Edit");
    expect(droidArgsCall?.[1]).toContain("Create");
    expect(droidArgsCall?.[1]).toContain("ApplyPatch");
    expect(droidArgsCall?.[1]).toContain("Execute");
    expect(droidArgsCall?.[1]).toContain('--tag "droid-fix"');
  });

  it("prepares thread-reply fix flow via @droid fix on review comment", async () => {
    const context = createMockContext({
      eventName: "pull_request_review_comment",
      isPR: true,
      actor: "human-user",
      entityNumber: 10889,
      repository: {
        owner: "Factory-AI",
        repo: "factory-mono",
        full_name: "Factory-AI/factory-mono",
      },
      payload: {
        action: "created",
        comment: {
          id: 2914349333,
          body: "@droid fix",
          path: "packages/common/src/shared/constants.ts",
          line: 1,
          in_reply_to_id: 2914349332,
          user: { login: "reviewer", id: 123 },
          created_at: "2024-01-02T00:00:00Z",
        },
        pull_request: {
          number: 10889,
          title: "[TEST] CI failure review validation",
          body: "Test PR with intentional type error",
          user: { login: "dev", id: 456 },
        },
      } as any,
    });

    const mockGetReviewComment = async () => ({
      data: {
        body: "[P1] DEV_FACTORY_APP_BASE_URL is typed as `number` but assigned a string\n\n`export const DEV_FACTORY_APP_BASE_URL: number = 'https://dev.app.factory.ai';` is a TypeScript type error (string is not assignable to number) and will break typechecking.",
        node_id: "node-1",
      },
    });

    const octokit = {
      rest: {
        pulls: {
          getReviewComment: mockGetReviewComment,
        },
      },
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: {
              baseRefName: "dev",
              headRefName: "ci-fail-review-test",
              headRefOid: "55cf61f",
              title: "[TEST] CI failure review validation",
              body: "Test PR with intentional type error",
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: "dev",
          headRefName: "ci-fail-review-test",
          headRefOid: "55cf61f",
          title: "[TEST] CI failure review validation",
          body: "Test PR with intentional type error",
        },
      },
    });

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    // Verify fix flow was selected
    expect(exportVarSpy).toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      "droid-fix",
    );
    expect(result.commentId).toBe(301);

    // Verify prompt was written and contains thread-specific context
    const promptPath = path.join(
      tmpDir,
      "droid-prompts",
      "droid-prompt.txt",
    );
    const prompt = await readFile(promptPath, "utf8");

    // Thread fix: should reference specific file and review comment
    expect(prompt).toContain("packages/common/src/shared/constants.ts");
    expect(prompt).toContain("around line 1");
    expect(prompt).toContain("DEV_FACTORY_APP_BASE_URL");
    expect(prompt).toContain("TypeScript type error");
    expect(prompt).toContain(
      "Only fix the specific issue mentioned in the review comment",
    );
    expect(prompt).toContain("git commit");
    expect(prompt).toContain("git push");
  });

  it("routes @droid (without fix) to review, not fix", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      actor: "human-user",
      entityNumber: 42,
      payload: {
        comment: {
          id: 555,
          body: "@droid please look at this",
          user: { login: "reviewer" },
          created_at: "2024-01-02T00:00:00Z",
        },
        issue: {
          number: 42,
          pull_request: {},
        },
      } as any,
    });

    // For review flow, createPrompt is called (which we need to mock differently)
    // We just verify it does NOT route to fix
    const promptSpy = spyOn(
      await import("../../src/create-prompt"),
      "createPrompt",
    ).mockResolvedValue();

    const octokit = {
      rest: {
        issues: { listComments: () => Promise.resolve({ data: [] }) },
        pulls: { listReviewComments: () => Promise.resolve({ data: [] }) },
      },
      graphql: () =>
        Promise.resolve({
          repository: {
            pullRequest: {
              baseRefName: "main",
              headRefName: "feature/test",
              headRefOid: "abc",
              title: "Test",
              body: "",
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: "main",
          headRefName: "feature/test",
          headRefOid: "abc",
          title: "Test",
          body: "",
        },
      },
    });

    await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    // Should be review, NOT fix
    expect(exportVarSpy).toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      "droid-review",
    );
    expect(exportVarSpy).not.toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      "droid-fix",
    );

    promptSpy.mockRestore();
  });
});
