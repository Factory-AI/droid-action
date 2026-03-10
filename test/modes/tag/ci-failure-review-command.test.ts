import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as core from "@actions/core";
import { prepareCIFailureReviewMode } from "../../../src/tag/commands/ci-failure-review";
import { createMockContext } from "../../mockContext";
import type { ParsedGitHubContext } from "../../../src/github/context";
import type { CheckRunCompletedEvent } from "@octokit/webhooks-types";

import * as promptModule from "../../../src/create-prompt";
import * as mcpInstaller from "../../../src/mcp/install-mcp-server";
import * as comments from "../../../src/github/operations/comments/create-initial";
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

function createCheckRunContext(
  overrides: Partial<{
    entityNumber: number;
    isPR: boolean;
    checkRunName: string;
    conclusion: string;
  }> = {},
): ParsedGitHubContext {
  const entityNumber = overrides.entityNumber ?? 42;
  const isPR = overrides.isPR ?? true;
  const checkRunName = overrides.checkRunName ?? "CI / build";
  const conclusion = overrides.conclusion ?? "failure";

  return {
    runId: "1234567890",
    eventName: "check_run",
    eventAction: "completed",
    repository: {
      owner: "test-owner",
      repo: "test-repo",
      full_name: "test-owner/test-repo",
    },
    actor: "github-actions[bot]",
    entityNumber,
    isPR,
    inputs: {
      triggerPhrase: "@droid",
      assigneeTrigger: "",
      labelTrigger: "",
      useStickyComment: false,
      allowedBots: "",
      allowedNonWriteUsers: "",
      trackProgress: false,
      automaticReview: false,
      automaticSecurityReview: false,
      securityModel: "",
      securitySeverityThreshold: "medium",
      securityBlockOnCritical: true,
      securityBlockOnHigh: false,
      securityNotifyTeam: "",
      securityScanSchedule: false,
      securityScanDays: 7,
      ciFailureReview: true,
    },
    payload: {
      action: "completed",
      check_run: {
        id: 12345,
        name: checkRunName,
        head_sha: "abc123def456",
        status: "completed",
        conclusion,
        html_url:
          "https://github.com/test-owner/test-repo/actions/runs/12345",
        started_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:05:00Z",
        output: {
          title: null,
          summary: null,
          text: null,
          annotations_count: 0,
          annotations_url: "",
        },
        external_id: "",
        url: "",
        check_suite: {
          id: 1,
          head_branch: "fix/ci-pipeline",
          head_sha: "abc123def456",
          status: "completed",
          conclusion: "failure",
          url: "",
          before: null,
          after: null,
          pull_requests: [
            {
              url: "",
              id: 1,
              number: entityNumber,
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
          ],
          app: {} as any,
          created_at: "",
          updated_at: "",
        },
        app: {} as any,
        pull_requests: [
          {
            url: "",
            id: 1,
            number: entityNumber,
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
        ],
      },
      repository: {
        name: "test-repo",
        full_name: "test-owner/test-repo",
        owner: { login: "test-owner" },
      },
      sender: { login: "github-actions[bot]" },
    } as unknown as CheckRunCompletedEvent,
  };
}

describe("prepareCIFailureReviewMode", () => {
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
    ).mockResolvedValue({ id: 888 } as any);
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
    createInitialSpy.mockRestore();
    exportVariableSpy.mockRestore();
    execSyncSpy.mockRestore();
    writeFileSpy.mockRestore();
    mkdirSpy.mockRestore();
    delete process.env.REVIEW_MODEL;
    delete process.env.REASONING_EFFORT;
  });

  it("prepares CI failure review with CI tools enabled", async () => {
    const context = createCheckRunContext();

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
          title: MOCK_PR_DATA.title,
          body: MOCK_PR_DATA.body,
        },
      },
    });

    const result = await prepareCIFailureReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 999,
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

  it("creates tracking comment when not provided", async () => {
    const context = createCheckRunContext();

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

    expect(createInitialSpy).toHaveBeenCalled();
    expect(result.commentId).toBe(888);
  });

  it("throws when check_run has no associated PR", async () => {
    const context = createCheckRunContext({ isPR: false, entityNumber: 0 });

    await expect(
      prepareCIFailureReviewMode({
        context,
        octokit: { rest: {}, graphql: () => {} } as any,
        githubToken: "token",
      }),
    ).rejects.toThrow(
      "CI failure review requires a check_run associated with a pull request",
    );
  });

  it("throws for non-check_run events", async () => {
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
    ).rejects.toThrow("CI failure review requires a check_run event");
  });

  it("includes CI context in the generated prompt", async () => {
    const context = createCheckRunContext({
      checkRunName: "Tests / unit-tests",
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
          title: MOCK_PR_DATA.title,
          body: MOCK_PR_DATA.body,
        },
      },
    });

    await prepareCIFailureReviewMode({
      context,
      octokit,
      githubToken: "token",
      trackingCommentId: 1000,
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
