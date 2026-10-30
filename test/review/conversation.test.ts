import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import * as core from "@actions/core";
import * as lifecycle from "../../src/github/operations/review-lifecycle";
import * as fixes from "../../src/github/operations/review-fix";
import { prepareConversationCommand } from "../../src/tag/commands/conversation";
import { postCommand } from "../../src/entrypoints/github-post-command";
import { createMockContext } from "../mockContext";
import { mkdtemp, readFile, rm, writeFile, symlink } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { createHash } from "crypto";
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
  let sourcesSpy: ReturnType<typeof spyOn>,
    outputSpy: ReturnType<typeof spyOn>,
    exportSpy: ReturnType<typeof spyOn>;
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
    sourcesSpy = spyOn(fixes, "fetchFixSources").mockResolvedValue({
      sources: [{ path: "src/file.ts", content: "source" }],
      skippedPaths: [],
    });
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
    sourcesSpy.mockRestore();
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
  test("disabled fixes never start Exec or fetch source snapshots", async () => {
    const disabled = context();
    disabled.inputs.reviewConfig = resolveReviewUxConfig({
      inputs: { fix_mode: "off" },
    });
    const result = await prepareConversationCommand({
      context: disabled,
      octokit: client,
      command: { command: "fix", raw: "@droid fix", location: "comment" },
    });
    expect(result.skipped).toBe(true);
    expect(sourcesSpy).not.toHaveBeenCalled();
    expect(output("command_mode")).toBe("");
    expect(issueComments[0].body).toContain("disabled");
  });
  test("PR fixes select every open thread but thread fixes select only that root", async () => {
    listSpy.mockResolvedValue([
      thread,
      {
        ...thread,
        id: "other",
        commentId: 200,
        findingId: "f-2",
        path: "src/other.ts",
        comments: [],
      },
      {
        ...thread,
        id: "resolved",
        commentId: 300,
        findingId: "f-3",
        path: "src/resolved.ts",
        resolved: true,
        comments: [],
      },
    ]);
    await prepareConversationCommand({
      context: context(),
      octokit: client,
      command: { command: "fix", raw: "@droid fix", location: "comment" },
    });
    expect(sourcesSpy.mock.calls[0]?.[1].allowedPaths).toEqual([
      "src/file.ts",
      "src/other.ts",
    ]);
    await prepareConversationCommand({
      context: context(true),
      octokit: client,
      command: { command: "fix", raw: "@droid fix", location: "comment" },
    });
    expect(sourcesSpy.mock.calls[1]?.[1].allowedPaths).toEqual(["src/file.ts"]);
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
  test("a question prepares file-only output and freezes the publisher/runtime digests", async () => {
    await prepareConversationCommand({
      context: context(true),
      octokit: client,
      command: {
        command: "question",
        text: "Why is this unsafe?",
        raw: "@droid why?",
        location: "comment",
      },
    });
    expect(output("command_mode")).toBe("question");
    expect(output("command_root_comment_id")).toBe("100");
    expect(output("run_code_review")).toBe("false");
    expect(output("mcp_tools")).toBe('{"mcpServers":{}}');
    expect(output("droid_args")).not.toContain("Execute");
    expect(output("droid_args")).not.toContain("malicious");
    const publisher = await readFile(output("command_publisher_path"));
    expect(createHash("sha256").update(publisher).digest("hex")).toBe(
      output("command_publisher_sha256"),
    );
    expect(output("command_runtime_sha256")).toMatch(/^[0-9a-f]{64}$/);
    const code = publisher.toString("utf8");
    expect(code).not.toMatch(/^\s*import[^;\n]*from\s+["'](?:@|\.|\/)/m);
    expect(replies).toHaveLength(0);
  });
  test("fix gathers only selected snapshots and restricts the model to file tools", async () => {
    await prepareConversationCommand({
      context: context(true),
      octokit: client,
      command: { command: "fix", raw: "@droid fix", location: "comment" },
    });
    expect(sourcesSpy.mock.calls[0]?.[1].allowedPaths).toEqual(["src/file.ts"]);
    expect(output("command_expected_head")).toBe(head);
    expect(output("command_fix_mode")).toBe("commit");
    expect(output("droid_args")).toContain("ApplyPatch");
    expect(output("droid_args")).not.toContain("Execute");
    const prompt = await readFile(
      path.join(dir, "droid-prompts/droid-prompt.txt"),
      "utf8",
    );
    expect(prompt).toContain("untrusted review data");
    expect(prompt).toContain("Do not claim tests ran");
  });
  test("publisher answers only the verified root thread, without review or top-level comments", async () => {
    const outputPath = path.join(dir, "answer.txt");
    await writeFile(
      outputPath,
      "This guard cannot protect the concurrent request.",
    );
    await postCommand(client, {
      owner: "org",
      repo: "repo",
      prNumber: 12,
      actor: "maintainer",
      mode: "question",
      expectedHead: head,
      fixMode: "commit",
      outputPath,
      rootCommentId: 100,
      success: true,
    });
    expect(replies).toEqual([
      {
        owner: "org",
        repo: "repo",
        pull_number: 12,
        comment_id: 100,
        body: "This guard cannot protect the concurrent request.",
      },
    ]);
    expect(issueComments).toHaveLength(0);
  });
  test("publisher refuses forged root comments and symlink output", async () => {
    const outputPath = path.join(dir, "answer.txt");
    await writeFile(outputPath, "answer");
    const options = {
      owner: "org",
      repo: "repo",
      prNumber: 12,
      actor: "maintainer",
      mode: "question" as const,
      expectedHead: head,
      fixMode: "commit" as const,
      outputPath,
      rootCommentId: 999,
      success: true,
    };
    await expect(postCommand(client, options)).rejects.toThrow(
      "verified Droid",
    );
    expect(replies).toHaveLength(0);
    const link = path.join(dir, "symlink");
    await symlink(outputPath, link);
    await expect(
      postCommand(client, { ...options, rootCommentId: 100, outputPath: link }),
    ).rejects.toThrow("regular file");
    expect(replies[0].body).toContain("could not answer");
  });
  test("missing finding files are communicated while available sources remain fixable", async () => {
    sourcesSpy.mockResolvedValue({
      sources: [{ path: "src/file.ts", content: "source" }],
      skippedPaths: ["deleted.ts"],
    });
    await prepareConversationCommand({
      context: context(),
      octokit: client,
      command: { command: "fix", raw: "@droid fix", location: "comment" },
    });
    const data = JSON.parse(
      await readFile(
        path.join(path.dirname(output("command_output_path")), "context.json"),
        "utf8",
      ),
    );
    expect(data.sources).toEqual([{ path: "src/file.ts", content: "source" }]);
    expect(data.skippedFindings).toEqual([
      { path: "deleted.ts", reason: "Source missing at the expected PR head" },
    ]);
    expect(issueComments[0].body).toContain("Skipped 1");
    expect(output("command_mode")).toBe("fix");
  });
  test("all missing finding sources stop truthfully before model preparation", async () => {
    sourcesSpy.mockResolvedValue({ sources: [], skippedPaths: ["deleted.ts"] });
    const result = await prepareConversationCommand({
      context: context(),
      octokit: client,
      command: { command: "fix", raw: "@droid fix", location: "comment" },
    });
    expect(result.skipped).toBe(true);
    expect(issueComments[0].body).toContain("No fix was started");
    expect(output("command_mode")).toBe("");
    expect(output("command_output_path")).toBe("");
  });
  test("a missing second fix proposal cannot reuse the first invocation's output", async () => {
    const command = {
      command: "fix" as const,
      raw: "@droid fix",
      location: "comment" as const,
    };
    await prepareConversationCommand({
      context: context(),
      octokit: client,
      command,
    });
    const first = output("command_output_path");
    await writeFile(
      first,
      JSON.stringify({
        summary: "old fix",
        files: [{ path: "src/file.ts", content: "old proposal" }],
      }),
    );
    outputSpy.mockClear();
    await prepareConversationCommand({
      context: context(),
      octokit: client,
      command,
    });
    const second = output("command_output_path");
    const publishSpy = spyOn(fixes, "publishReviewFix").mockResolvedValue({
      sha: head,
      body: "stale fix published",
    });
    try {
      await expect(
        postCommand(client, {
          owner: "org",
          repo: "repo",
          prNumber: 12,
          actor: "maintainer",
          mode: "fix",
          expectedHead: head,
          fixMode: "commit",
          outputPath: second,
          success: true,
        }),
      ).rejects.toThrow();
      expect(second).not.toBe(first);
      expect(publishSpy).not.toHaveBeenCalled();
      expect(
        issueComments.some((comment) =>
          comment.body.includes("stale fix published"),
        ),
      ).toBe(false);
    } finally {
      publishSpy.mockRestore();
    }
  });
});
