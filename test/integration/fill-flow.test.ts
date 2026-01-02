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

describe("fill command integration", () => {
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
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fill-int-"));
    process.env.RUNNER_TEMP = tmpDir;
    process.env.DROID_ARGS = "";

    createCommentSpy = spyOn(
      createInitial,
      "createInitialComment",
    ).mockResolvedValue({ id: 101 } as any);

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

  it("prepares fill flow end-to-end", async () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      actor: "human-user",
      entityNumber: 42,
      repository: {
        owner: "test-owner",
        repo: "test-repo",
        full_name: "test-owner/test-repo",
      },
      payload: {
        comment: {
          id: 555,
          body: "@droid fill please",
          user: { login: "reviewer" },
          created_at: "2024-01-02T00:00:00Z",
        },
        issue: {
          number: 42,
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
              headRefName: "feature/fill",
              headRefOid: "abc123",
            },
          },
        }),
    } as any;

    graphqlSpy = spyOn(octokit, "graphql").mockResolvedValue({
      repository: {
        pullRequest: {
          baseRefName: "main",
          headRefName: "feature/fill",
          headRefOid: "abc123",
        },
      },
    });

    const result = await prepareTagExecution({
      context,
      octokit,
      githubToken: "token",
    });

    expect(result.commentId).toBe(101);
    expect(graphqlSpy).toHaveBeenCalled();
    expect(mcpSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: expect.arrayContaining([
          "github_pr___update_pr_description",
        ]),
      }),
    );

    const promptPath = path.join(
      process.env.RUNNER_TEMP!,
      "droid-prompts",
      "droid-prompt.txt",
    );
    const prompt = await readFile(promptPath, "utf8");

    expect(prompt).toContain("Procedure:");
    expect(prompt).toContain("gh pr diff 42 --repo test-owner/test-repo");
    expect(prompt).toContain("github_pr___update_pr_description");
    expect(prompt).toContain("For sections you cannot verify");
    const droidArgsCall = setOutputSpy.mock.calls.find(
      (call: unknown[]) => call[0] === "droid_args",
    ) as [string, string] | undefined;
    expect(droidArgsCall?.[1]).toContain("github_pr___update_pr_description");
  });
});
