import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import * as core from "@actions/core";
import * as lifecycle from "../../src/github/operations/review-lifecycle";
import { prepareConversationCommand } from "../../src/tag/commands/conversation";
import { createMockContext } from "../mockContext";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { Octokits } from "../../src/github/api/client";
import { prepareTagExecution } from "../../src/tag";
import * as actors from "../../src/github/validation/actor";
import * as reviewMode from "../../src/tag/commands/review";
import { resolveReviewUxConfig } from "../../src/core/review/config";

const head = "a".repeat(40);
const thread: lifecycle.DroidReviewThread = {
  id: "thread",
  nodeId: "thread",
  commentId: 100,
  body: "Verified finding",
  path: "src/file.ts",
  line: 4,
  resolved: false,
  url: "https://github.com/org/repo/pull/12#discussion_r100",
  findingId: "f-1",
  comments: [
    { id: 100, body: "Verified finding" },
    { id: 101, body: "@droid why?" },
  ],
};
describe("command execution isolation and replies", () => {
  let dir: string;
  let previousTemp: string | undefined, previousArgs: string | undefined;
  let listSpy: ReturnType<typeof spyOn>,
    pausedSpy: ReturnType<typeof spyOn>,
    resolveSpy: ReturnType<typeof spyOn>;
  let outputSpy: ReturnType<typeof spyOn>, exportSpy: ReturnType<typeof spyOn>;
  let replies: any[], issueComments: any[];
  let client: Octokits;
  let actorSpy: ReturnType<typeof spyOn>;
  let reviewSpy: ReturnType<typeof spyOn>;
  beforeEach(async () => {
    actorSpy = spyOn(actors, "checkHumanActor").mockResolvedValue();
    reviewSpy = spyOn(reviewMode, "prepareReviewMode").mockResolvedValue({
      branchInfo: { baseBranch: "main", currentBranch: "feature" },
      mcpTools: "",
    });
    dir = await mkdtemp(path.join(tmpdir(), "droid-command-test-"));
    previousTemp = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = dir;
    previousArgs = process.env.DROID_ARGS;
    process.env.DROID_ARGS =
      '--enabled-tools "Execute" --mcp-config malicious.json';
    listSpy = spyOn(lifecycle, "listDroidThreads").mockResolvedValue([thread]);
    pausedSpy = spyOn(lifecycle, "setReviewPaused").mockResolvedValue();
    resolveSpy = spyOn(lifecycle, "resolveAllDroidThreads").mockResolvedValue(
      1,
    );
    outputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
    exportSpy = spyOn(core, "exportVariable").mockImplementation(() => {});
    replies = [];
    issueComments = [];
    client = {
      rest: {
        pulls: {
          get: async () => ({
            data: {
              head: {
                sha: head,
                ref: "feature",
                repo: { owner: { login: "org" }, name: "repo" },
              },
              base: { ref: "main" },
            },
          }),
          createReplyForReviewComment: async (value: any) => {
            replies.push(value);
            return { data: {} };
          },
        },
        issues: {
          createComment: async (value: any) => {
            issueComments.push(value);
            return { data: {} };
          },
        },
        repos: {
          getContent: async () => ({
            data: {
              type: "file",
              size: 6,
              content: Buffer.from("source").toString("base64"),
            },
          }),
        },
      },
      graphql: async () => ({}),
    } as unknown as Octokits;
  });
  afterEach(async () => {
    actorSpy.mockRestore();
    reviewSpy.mockRestore();
    listSpy.mockRestore();
    pausedSpy.mockRestore();
    resolveSpy.mockRestore();
    outputSpy.mockRestore();
    exportSpy.mockRestore();
    if (previousTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousTemp;
    if (previousArgs === undefined) delete process.env.DROID_ARGS;
    else process.env.DROID_ARGS = previousArgs;
    await rm(dir, { recursive: true, force: true });
  });
  const context = (reviewThread = false) =>
    createMockContext({
      eventName: reviewThread ? "pull_request_review_comment" : "issue_comment",
      isPR: true,
      entityNumber: 12,
      inputs: {
        ...createMockContext().inputs,
        reviewConfig: resolveReviewUxConfig(),
      },
      payload: {
        comment: { id: 101, in_reply_to_id: 100, body: "@droid why?" },
      } as any,
    });
  function output(name: string): string {
    return String(
      outputSpy.mock.calls.find((call: unknown[]) => call[0] === name)?.[1] ??
        "",
    );
  }
  test("help and unknown commands complete without preparing a review or Exec", async () => {
    const result = await prepareConversationCommand({
      context: context(),
      octokit: client,
      command: { command: "unknown", raw: "@droid typo", location: "comment" },
    });
    expect(result.skipped).toBe(true);
    expect(issueComments[0].body).toContain("@droid review --full");
    expect(output("run_code_review")).toBe("false");
    expect(output("droid_args")).toBe("");
  });
  test("the real dispatcher routes unknown comments to help even with automatic review enabled", async () => {
    const automatic = context();
    automatic.inputs.automaticReview = true;
    automatic.payload = {
      comment: { id: 101, body: "@droid frobnicate" },
    } as any;
    const result = await prepareTagExecution({
      context: automatic,
      octokit: client,
      githubToken: "unused",
    });
    expect(result.skipped).toBe(true);
    expect(reviewSpy).not.toHaveBeenCalled();
    expect(issueComments[0].body).toContain("### Droid commands");
  });
  test("pause, resume, resolve dispatch only the requested control helper", async () => {
    for (const command of ["pause", "resume", "resolve"] as const)
      await prepareConversationCommand({
        context: context(),
        octokit: client,
        command: { command, raw: `@droid ${command}`, location: "comment" },
      });
    expect(
      pausedSpy.mock.calls.map((call: [{ paused: boolean }]) => call[0].paused),
    ).toEqual([true, false]);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(issueComments[2].body).toBe("Resolved 1 Droid finding thread.");
  });
});
