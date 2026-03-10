import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import { prepareCIFailureReviewMode } from "../../../src/tag/commands/ci-failure-review";
import { createMockContext, createMockAutomationContext } from "../../mockContext";
import type { AutomationContext } from "../../../src/github/context";
import type { WorkflowRunCompletedEvent } from "@octokit/webhooks-types";

import * as promptModule from "../../../src/create-prompt";
import * as mcpInstaller from "../../../src/mcp/install-mcp-server";
import * as childProcess from "child_process";
import * as fsPromises from "fs/promises";

const MOCK_PR_DATA = {
  title: "Fix CI pipeline",
  body: "This PR fixes the build",
  author: { login: "author" },
  baseRefName: "main",
  headRefName: "fix/ci-pipeline",
  headRefOid: "abc123",
  createdAt: "2024-01-01T00:00:00Z",
  additions: 10,
  deletions: 2,
  state: "OPEN",
  commits: { totalCount: 1, nodes: [] },
  files: { nodes: [] },
  comments: { nodes: [] },
  reviews: { nodes: [] },
} as any;

function createWorkflowRunContext(
  overrides: Partial<{
    prNumber: number;
    hasPR: boolean;
    workflowName: string;
    conclusion: string;
  }> = {},
): AutomationContext {
  const prNumber = overrides.prNumber ?? 42;
  const hasPR = overrides.hasPR ?? true;
  const workflowName = overrides.workflowName ?? "Typecheck";
  const conclusion = overrides.conclusion ?? "failure";

  return {
    ...createMockAutomationContext({
      eventName: "workflow_run",
      inputs: {
        ...createMockContext().inputs,
        ciFailureReview: true,
      },
    }),
    payload: {
      action: "completed",
      workflow_run: {
        id: 12345,
        name: workflowName,
        head_sha: "abc123def456",
        head_branch: "fix/ci-pipeline",
        conclusion,
        html_url: "https://github.com/test-owner/test-repo/actions/runs/12345",
        display_title: workflowName,
        path: ".github/workflows/typecheck.yml",
        pull_requests: hasPR
          ? [
              {
                url: "",
                id: 1,
                number: prNumber,
                head: {
                  ref: "fix/ci-pipeline",
                  sha: "abc123def456",
                  repo: { id: 1, url: "", name: "test-repo" },
                },
                base: {
                  ref: "main",
                  sha: "000000",
                  repo: { id: 1, url: "", name: "test-repo" },
                },
              },
            ]
          : [],
      },
      workflow: { id: 1, name: workflowName },
      repository: {
        name: "test-repo",
        full_name: "test-owner/test-repo",
        owner: { login: "test-owner" },
      },
      sender: { login: "github-actions[bot]" },
    } as unknown as WorkflowRunCompletedEvent,
  };
}

describe("prepareCIFailureReviewMode", () => {
  let graphqlSpy: ReturnType<typeof spyOn>;
  let promptSpy: ReturnType<typeof spyOn>;
  let mcpSpy: ReturnType<typeof spyOn>;
  let setOutputSpy: ReturnType<typeof spyOn>;
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
    exportVariableSpy = spyOn(core, "exportVariable").mockImplementation(
      () => {},
    );
    execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
      cmd: string,
    ) => {
      if (cmd.includes("merge-base")) return "abc123def456\n";
      if (cmd.includes("diff"))
        return "diff --git a/file.ts b/file.ts\n+added line\n";
      return "";
    }) as typeof childProcess.execSync);
    writeFileSpy = spyOn(fsPromises, "writeFile").mockResolvedValue();
    mkdirSpy = spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
  });

  afterEach(() => {
    graphqlSpy?.mockRestore();
    promptSpy.mockRestore();
    mcpSpy.mockRestore();
    setOutputSpy.mockRestore();
    exportVariableSpy.mockRestore();
    execSyncSpy.mockRestore();
    writeFileSpy.mockRestore();
    mkdirSpy.mockRestore();
    delete process.env.REVIEW_MODEL;
    delete process.env.REASONING_EFFORT;
  });

  it("prepares CI failure review with CI tools and workflow run context", async () => {
    const context = createWorkflowRunContext();

    const octokit = {
      rest: {
        issues: {
          listComments: () => Promise.resolve({ data: [] }),
          createComment: () =>
            Promise.resolve({ data: { id: 999 } }),
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
          title: MOCK_PR_DATA.title,
          body: MOCK_PR_DATA.body,
        },
      },
    });

    const result = await prepareCIFailureReviewMode({
      context,
      octokit,
      githubToken: "token",
    });

    expect(promptSpy).toHaveBeenCalled();
    expect(result.commentId).toBe(999);
    expect(result.branchInfo.baseBranch).toBe("main");

    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(droidArgsCall?.[1]).toContain("github_ci___get_ci_status");
    expect(droidArgsCall?.[1]).toContain(
      "github_ci___get_workflow_run_details",
    );
    expect(droidArgsCall?.[1]).toContain("github_ci___download_job_log");
    expect(droidArgsCall?.[1]).toContain(
      "github_inline_comment___create_inline_comment",
    );
    expect(droidArgsCall?.[1]).toContain("github_pr___submit_review");
    expect(droidArgsCall?.[1]).toContain('"ci-failure-review"');

    expect(exportVariableSpy).toHaveBeenCalledWith(
      "DROID_EXEC_RUN_TYPE",
      "droid-ci-failure-review",
    );
  });

  it("throws when workflow_run has no associated PR", async () => {
    const context = createWorkflowRunContext({ hasPR: false });

    await expect(
      prepareCIFailureReviewMode({
        context,
        octokit: { rest: {}, graphql: () => {} } as any,
        githubToken: "token",
      }),
    ).rejects.toThrow(
      "CI failure review requires a workflow_run associated with a pull request",
    );
  });

  it("throws for non-workflow_run events", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
    });

    await expect(
      prepareCIFailureReviewMode({
        context,
        octokit: { rest: {}, graphql: () => {} } as any,
        githubToken: "token",
      }),
    ).rejects.toThrow("CI failure review requires a workflow_run event");
  });

  it("passes includeActionsTools to createPrompt", async () => {
    const context = createWorkflowRunContext({
      workflowName: "Tests / unit-tests",
    });

    const octokit = {
      rest: {
        issues: {
          listComments: () => Promise.resolve({ data: [] }),
          createComment: () =>
            Promise.resolve({ data: { id: 1000 } }),
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
          title: MOCK_PR_DATA.title,
          body: MOCK_PR_DATA.body,
        },
      },
    });

    await prepareCIFailureReviewMode({
      context,
      octokit,
      githubToken: "token",
    });

    expect(promptSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        includeActionsTools: true,
        reviewArtifacts: expect.objectContaining({
          diffPath: expect.any(String),
          commentsPath: expect.any(String),
          descriptionPath: expect.any(String),
        }),
      }),
    );
  });
});
