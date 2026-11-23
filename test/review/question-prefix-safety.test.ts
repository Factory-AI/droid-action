import { expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import * as lifecycle from "../../src/github/operations/review-lifecycle";
import * as actors from "../../src/github/validation/actor";
import * as reviewMode from "../../src/tag/commands/review";
import { prepareTagExecution } from "../../src/tag";
import { postCommand } from "../../src/entrypoints/github-post-command";
import type { Octokits } from "../../src/github/api/client";
import { createMockContext } from "../mockContext";

async function fixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "droid-question-prefix-"),
  );
  const previousTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = directory;
  const head = "a".repeat(40);
  let root = 100;
  const replies: Array<{ body: string; comment_id: number }> = [];
  const issueComments: unknown[] = [];
  const outputSpy = spyOn(core, "setOutput").mockImplementation(() => {});
  const exportSpy = spyOn(core, "exportVariable").mockImplementation(() => {});
  const actorSpy = spyOn(actors, "checkHumanActor").mockResolvedValue();
  const reviewSpy = spyOn(reviewMode, "prepareReviewMode").mockResolvedValue({
    branchInfo: { baseBranch: "main", currentBranch: "feature" },
    mcpTools: "",
  });
  const listSpy = spyOn(lifecycle, "listDroidThreads").mockImplementation(
    async () => [
      {
        id: `thread-${root}`,
        nodeId: `thread-${root}`,
        commentId: root,
        body: "Verified finding",
        path: "src/file.ts",
        line: 4,
        resolved: false,
        url: `https://github.com/org/repo/pull/12#discussion_r${root}`,
        findingId: `finding-${root}`,
        comments: [{ id: root, body: "Verified finding" }],
      },
    ],
  );
  const client = {
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
        createReplyForReviewComment: async (reply: {
          body: string;
          comment_id: number;
        }) => {
          replies.push(reply);
          return { data: {} };
        },
      },
      issues: {
        createComment: async (comment: unknown) => {
          issueComments.push(comment);
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
  } as unknown as Octokits;
  const output = (key: string) =>
    String(outputSpy.mock.calls.find((call) => call[0] === key)?.[1] ?? "");
  return {
    directory,
    replies,
    issueComments,
    output,
    reviewSpy,
    async prepare(body: string, rootId = 100) {
      root = rootId;
      outputSpy.mockClear();
      const context = createMockContext({
        eventName: "pull_request_review_comment",
        isPR: true,
        entityNumber: 12,
        payload: {
          comment: { id: root + 1, in_reply_to_id: root, body },
        } as any,
      });
      return prepareTagExecution({
        context,
        octokit: client,
        githubToken: "unused",
      });
    },
    async publish(outputPath: string, rootId: number) {
      // Kept in a variable so this regression remains valid when layer204 adds fixMode.
      const options = {
        owner: "org",
        repo: "repo",
        prNumber: 12,
        actor: "maintainer",
        mode: "question" as const,
        expectedHead: head,
        fixMode: "commit" as const,
        outputPath,
        rootCommentId: rootId,
        success: true,
      };
      return postCommand(client, options);
    },
    async cleanup() {
      for (const spy of [outputSpy, exportSpy, actorSpy, reviewSpy, listSpy])
        spy.mockRestore();
      if (previousTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = previousTemp;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("the real dispatcher answers a newline-separated finding question without a review", async () => {
  const f = await fixture();
  try {
    await f.prepare("@droid\nWhy is this unsafe?\nWhich guard applies?");
    expect(f.reviewSpy).not.toHaveBeenCalled();
    expect(f.output("command_mode")).toBe("question");
    const data = JSON.parse(
      await readFile(
        path.join(
          path.dirname(f.output("command_output_path")),
          "context.json",
        ),
        "utf8",
      ),
    );
    expect(data.question).toBe("Why is this unsafe?\nWhich guard applies?");
  } finally {
    await f.cleanup();
  }
});

test("a second successful invocation cannot publish the first thread's answer", async () => {
  const f = await fixture();
  try {
    await f.prepare("@droid why?");
    const first = f.output("command_output_path");
    await writeFile(first, "Answer for the first finding only");
    await f.prepare("@droid why?", 200);
    const second = f.output("command_output_path");
    await expect(f.publish(second, 200)).rejects.toThrow();
    expect(second).not.toBe(first);
    expect(path.dirname(second).startsWith(f.directory + path.sep)).toBe(true);
    expect(
      f.replies.some((reply) =>
        reply.body.includes("Answer for the first finding only"),
      ),
    ).toBe(false);
    expect(f.issueComments).toHaveLength(0);
    expect(await readFile(first, "utf8")).toBe(
      "Answer for the first finding only",
    );
  } finally {
    await f.cleanup();
  }
});
