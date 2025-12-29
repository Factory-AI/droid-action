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
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    exportVarSpy = spyOn(core, "exportVariable").mockImplementation(() => {});
  });

  afterEach(async () => {
    graphqlSpy?.mockRestore();
    createCommentSpy.mockRestore();
    mcpSpy.mockRestore();
    actorSpy.mockRestore();
    setOutputSpy.mockRestore();
    exportVarSpy.mockRestore();

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
      rest: {},
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

    expect(result.commentId).toBe(202);
    expect(graphqlSpy).toHaveBeenCalled();
    expect(mcpSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: expect.arrayContaining([
          "github_pr___list_review_comments",
          "github_pr___submit_review",
          "github_inline_comment___create_inline_comment",
          "github_pr___resolve_review_thread",
        ]),
      }),
    );

    const promptPath = path.join(
      process.env.RUNNER_TEMP!,
      "droid-prompts",
      "droid-prompt.txt",
    );
    const prompt = await readFile(promptPath, "utf8");

    expect(prompt).toContain("You are performing an automated code review");
    expect(prompt).toContain("github_inline_comment___create_inline_comment");
    expect(prompt).toContain("cap at 10 comments total");
    expect(prompt).toContain(
      "gh pr view 7 --repo test-owner/test-repo --json comments,reviews",
    );
    expect(prompt).toContain("False positives are very undesirable");
    expect(prompt).toContain(
      "every substantive comment must be inline on the changed line",
    );
    expect(prompt).toContain("github_pr___resolve_review_thread");

    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;

    expect(droidArgsCall?.[1]).toContain("github_pr___list_review_comments");
    expect(droidArgsCall?.[1]).toContain("github_pr___submit_review");
    expect(droidArgsCall?.[1]).toContain(
      "github_inline_comment___create_inline_comment",
    );
    expect(droidArgsCall?.[1]).toContain("github_pr___resolve_review_thread");
  });
});
