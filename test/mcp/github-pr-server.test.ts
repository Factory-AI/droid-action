import { describe, expect, it } from "bun:test";
import {
  MAX_SUBMIT_REVIEW_ATTEMPTS,
  createGitHubPRServer,
  createSubmitReviewGuard,
  deletePullRequestComment,
  handleSubmitReview,
  listReviewAndIssueComments,
  minimizeComment,
  replyToPullRequestComment,
  submitReviewWithComments,
  resolveReviewThread,
  type OctokitLike,
  type ReviewComment,
} from "../../src/mcp/github-pr-server";

function createOctokitStub() {
  const calls = {
    listReview: [] as any[],
    listIssue: [] as any[],
    createReview: [] as any[],
    deleteReview: [] as any[],
    deleteIssue: [] as any[],
    replyReview: [] as any[],
    createIssueComment: [] as any[],
    graphql: [] as any[],
    getReviewComment: [] as any[],
  };

  const client: OctokitLike = {
    rest: {
      pulls: {
        listReviewComments: async (...args: any[]) => {
          calls.listReview.push(args);
          return { data: [{ id: 2 }] };
        },
        createReview: async (...args: any[]) => {
          calls.createReview.push(args);
          return { data: { id: 9001 } };
        },
        deleteReviewComment: async (...args: any[]) => {
          calls.deleteReview.push(args);
          return {};
        },
        getReviewComment: async (...args: any[]) => {
          calls.getReviewComment.push(args);
          const [params] = args as [
            { owner?: string; repo?: string; comment_id?: number },
          ];
          const pullRequestUrl =
            params?.owner && params?.repo
              ? `https://api.github.com/repos/${params.owner}/${params.repo}/pulls/5`
              : "https://api.github.com/repos/test/test/pulls/5";

          return {
            data: {
              node_id: "node-review",
              pull_request_url: pullRequestUrl,
            },
          };
        },
        createReplyForReviewComment: async (...args: any[]) => {
          calls.replyReview.push(args);
          return { data: { id: 7 } };
        },
        update: async () => ({}),
        get: async () => ({ data: {} }),
      },
      issues: {
        listComments: async (...args: any[]) => {
          calls.listIssue.push(args);
          return { data: [{ id: 1 }] };
        },
        deleteComment: async (...args: any[]) => {
          calls.deleteIssue.push(args);
          return {};
        },
        getComment: async () => ({ data: { node_id: "node-issue" } }),
        createComment: async (...args: any[]) => {
          calls.createIssueComment.push(args);
          return { data: { id: 8 } };
        },
      },
    },
    graphql: async (...args: any[]) => {
      calls.graphql.push(args);
      const [query, variables] = args as [string, Record<string, unknown>];

      if (typeof query === "string" && query.includes("GetReviewThread")) {
        return {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "thread-123",
                    comments: {
                      nodes: [{ id: "node-review" }],
                    },
                  },
                ],
              },
            },
          },
        };
      }

      if (typeof query === "string" && query.includes("ResolveReviewThread")) {
        return {
          resolveReviewThread: {
            thread: {
              id: variables?.threadId ?? "thread-123",
              isResolved: true,
            },
          },
        };
      }

      return {};
    },
  };

  return { client, calls };
}

describe("github-pr-server helpers", () => {
  it("lists review and issue comments", async () => {
    const { client, calls } = createOctokitStub();

    const result = await listReviewAndIssueComments({
      owner: "owner",
      repo: "repo",
      prNumber: 42,
      octokit: client,
      perPage: 50,
    });

    expect(calls.listIssue[0][0]).toEqual({
      owner: "owner",
      repo: "repo",
      issue_number: 42,
      per_page: 50,
    });
    expect(calls.listReview[0][0]).toEqual({
      owner: "owner",
      repo: "repo",
      pull_number: 42,
      per_page: 50,
    });
    expect(result.issueComments).toEqual([{ id: 1 }]);
    expect(result.reviewComments).toEqual([{ id: 2 }]);
  });

  it("submits review with comments", async () => {
    const { client, calls } = createOctokitStub();

    const reviewId = await submitReviewWithComments({
      owner: "o",
      repo: "r",
      prNumber: 7,
      body: "Summary",
      comments: [{ path: "file.ts", position: 3, body: "issue" }],
      octokit: client,
    });

    expect(calls.createReview[0][0]).toEqual({
      owner: "o",
      repo: "r",
      pull_number: 7,
      event: "COMMENT",
      body: "Summary",
      comments: [{ path: "file.ts", position: 3, body: "issue" }],
    });
    expect(reviewId).toBe(9001);
  });

  it("deletes issue and review comments", async () => {
    const { client, calls } = createOctokitStub();

    await deletePullRequestComment({
      owner: "o",
      repo: "r",
      commentId: 11,
      type: "issue",
      octokit: client,
    });
    expect(calls.deleteIssue[0][0]).toEqual({
      owner: "o",
      repo: "r",
      comment_id: 11,
    });

    await deletePullRequestComment({
      owner: "o",
      repo: "r",
      commentId: 22,
      type: "review",
      octokit: client,
    });
    expect(calls.deleteReview[0][0]).toEqual({
      owner: "o",
      repo: "r",
      comment_id: 22,
    });
  });

  it("minimizes comment via graphql", async () => {
    const { client, calls } = createOctokitStub();

    await minimizeComment({
      nodeId: "node-id",
      classifier: "OUTDATED",
      octokit: client,
    });

    expect(calls.graphql[0][0]).toContain("mutation MinimizeComment");
    expect(calls.graphql[0][1]).toEqual({
      subjectId: "node-id",
      classifier: "OUTDATED",
    });
  });

  it("replies to review and issue comments", async () => {
    const { client, calls } = createOctokitStub();

    await replyToPullRequestComment({
      owner: "o",
      repo: "r",
      prNumber: 5,
      commentId: 44,
      body: "Thanks!",
      type: "review",
      octokit: client,
    });

    expect(calls.replyReview[0][0]).toEqual({
      owner: "o",
      repo: "r",
      pull_number: 5,
      comment_id: 44,
      body: "Thanks!",
    });

    await replyToPullRequestComment({
      owner: "o",
      repo: "r",
      prNumber: 5,
      commentId: 55,
      body: "Acknowledged",
      type: "issue",
      octokit: client,
    });

    expect(calls.createIssueComment[0][0]).toEqual({
      owner: "o",
      repo: "r",
      issue_number: 5,
      body: "Acknowledged",
    });
  });

  it("resolves review thread via comment id", async () => {
    const { client, calls } = createOctokitStub();

    await resolveReviewThread({
      owner: "o",
      repo: "r",
      commentId: 33,
      octokit: client,
    });

    expect(calls.getReviewComment[0][0]).toEqual({
      owner: "o",
      repo: "r",
      comment_id: 33,
    });
    expect(calls.graphql[0][0]).toContain("GetReviewThread");
    expect(calls.graphql[0][1]).toEqual({
      owner: "o",
      repo: "r",
      prNumber: 5,
      headers: { accept: "application/vnd.github.comfort-fade-preview+json" },
    });
    expect(calls.graphql[1][0]).toContain("ResolveReviewThread");
    expect(calls.graphql[1][1]).toEqual({
      threadId: "thread-123",
      headers: { accept: "application/vnd.github.comfort-fade-preview+json" },
    });
  });

  it("resolves review thread via thread node id", async () => {
    const { client, calls } = createOctokitStub();

    await resolveReviewThread({
      owner: "o",
      repo: "r",
      threadNodeId: "thread-xyz",
      octokit: client,
    });

    expect(calls.getReviewComment.length).toBe(0);
    expect(calls.graphql[0][0]).toContain("ResolveReviewThread");
    expect(calls.graphql[0][1]).toEqual({
      threadId: "thread-xyz",
      headers: { accept: "application/vnd.github.comfort-fade-preview+json" },
    });
  });
});

describe("submit_review idempotency guard", () => {
  const commentA: ReviewComment = {
    path: "src/a.ts",
    line: 10,
    side: "RIGHT",
    body: "[P1] Null deref",
  };
  const commentB: ReviewComment = {
    path: "src/b.ts",
    line: 20,
    side: "RIGHT",
    body: "[P2] Missing await",
  };

  function submit(
    client: OctokitLike,
    guard: ReturnType<typeof createSubmitReviewGuard>,
    input: { body?: string; comments?: ReviewComment[] },
  ) {
    return handleSubmitReview({
      owner: "o",
      repo: "r",
      prNumber: 7,
      octokit: client,
      guard,
      ...input,
    });
  }

  it("posts the first call, then answers every repeat from memory without touching GitHub", async () => {
    const { client, calls } = createOctokitStub();
    const guard = createSubmitReviewGuard();

    const first = await submit(client, guard, {
      comments: [commentA, commentB],
    });
    expect(first.isError).toBe(false);
    expect(first.text).toContain("Submitted review 9001");
    expect(first.text).toContain("2 inline comments");
    expect(calls.createReview).toHaveLength(1);

    // The failure mode from AUT-2090: the model re-submits the same batch
    // hundreds of times because nothing tells it the review already exists.
    for (let i = 0; i < 5; i++) {
      const again = await submit(client, guard, {
        comments: [commentA, commentB],
      });
      expect(again.isError).toBe(true);
      expect(again.text).toBe(
        "A review with these 2 comments was already submitted as review 9001. " +
          "Do not call submit_review again.",
      );
    }
    expect(calls.createReview).toHaveLength(1);
  });

  it("atomically refuses a concurrent call while the first is in flight", async () => {
    const { client, calls } = createOctokitStub();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.rest.pulls.createReview = async (...args: any[]) => {
      calls.createReview.push(args);
      await pending;
      return { data: { id: 9001 } };
    };
    const guard = createSubmitReviewGuard();

    const first = submit(client, guard, { comments: [commentA] });
    await Promise.resolve();
    const concurrent = await submit(client, guard, { comments: [commentA] });

    expect(concurrent).toEqual({
      text:
        "A review submission is already in progress. " +
        "Do not call submit_review again.",
      isError: true,
    });
    expect(calls.createReview).toHaveLength(1);

    release();
    expect((await first).isError).toBe(false);
  });

  it("refuses a second review even when it carries new or reworded comments", async () => {
    const { client, calls } = createOctokitStub();
    const guard = createSubmitReviewGuard();

    await submit(client, guard, { comments: [commentA] });

    const reworded = await submit(client, guard, {
      comments: [{ ...commentA, body: "[P1] Null deref (reworded)" }],
    });
    expect(reworded.isError).toBe(true);
    expect(reworded.text).toBe(
      "A review with these 1 comments was already submitted as review 9001. " +
        "Do not call submit_review again.",
    );

    const mixed = await submit(client, guard, {
      comments: [commentA, commentB],
    });
    expect(mixed.isError).toBe(true);
    expect(mixed.text).toBe(
      "A review with these 1 comments was already submitted as review 9001. " +
        "Do not call submit_review again.",
    );

    const bodyOnly = await submit(client, guard, { body: "Summary" });
    expect(bodyOnly.isError).toBe(true);

    expect(calls.createReview).toHaveLength(1);
  });

  it("recognises the same comment regardless of surrounding whitespace or an explicit default side", async () => {
    const { client } = createOctokitStub();
    const guard = createSubmitReviewGuard();

    await submit(client, guard, { comments: [commentA] });
    const again = await submit(client, guard, {
      comments: [{ path: "src/a.ts", line: 10, body: "  [P1] Null deref \n" }],
    });

    expect(again.isError).toBe(true);
    // Every comment matched, so no "not part of that review" note.
    expect(again.text).not.toContain("not part of that review");
  });

  it("rejects a call with nothing to post without calling GitHub or consuming the submission", async () => {
    const { client, calls } = createOctokitStub();
    const guard = createSubmitReviewGuard();

    const empty = await submit(client, guard, {});
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain("no comments and no body");
    const blank = await submit(client, guard, { body: "   ", comments: [] });
    expect(blank.isError).toBe(true);
    expect(calls.createReview).toHaveLength(0);

    const real = await submit(client, guard, { comments: [commentA] });
    expect(real.isError).toBe(false);
    expect(calls.createReview).toHaveLength(1);
  });

  it("lets a failed post be corrected and retried, but bounds total GitHub attempts", async () => {
    const { client, calls } = createOctokitStub();
    let failuresLeft = 2;
    client.rest.pulls.createReview = async (...args: any[]) => {
      calls.createReview.push(args);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("Validation Failed: line must be part of the diff");
      }
      return { data: { id: 9002 } };
    };
    const guard = createSubmitReviewGuard();

    await expect(
      submit(client, guard, { comments: [commentA] }),
    ).rejects.toThrow(/part of the diff/);
    await expect(
      submit(client, guard, { comments: [commentA] }),
    ).rejects.toThrow(/part of the diff/);

    // A failed post is not a submission, so the corrected retry still posts.
    const fixed = await submit(client, guard, {
      comments: [{ ...commentA, line: 11 }],
    });
    expect(fixed.isError).toBe(false);
    expect(fixed.text).toContain("Submitted review 9002");
    expect(calls.createReview).toHaveLength(3);

    const flaky = createOctokitStub();
    flaky.client.rest.pulls.createReview = async (...args: any[]) => {
      flaky.calls.createReview.push(args);
      throw new Error("boom");
    };
    const flakyGuard = createSubmitReviewGuard();
    for (let i = 0; i < MAX_SUBMIT_REVIEW_ATTEMPTS; i++) {
      await expect(
        submit(flaky.client, flakyGuard, { comments: [commentA] }),
      ).rejects.toThrow("boom");
    }
    await expect(
      submit(flaky.client, flakyGuard, { comments: [commentA] }),
    ).rejects.toThrow(/attempted 5 times .* maximum/);
    expect(flaky.calls.createReview).toHaveLength(MAX_SUBMIT_REVIEW_ATTEMPTS);
  });

  it("reports repeat calls as tool errors through the MCP server", async () => {
    const { client, calls } = createOctokitStub();
    const guard = createSubmitReviewGuard();
    const server = createGitHubPRServer({
      owner: "o",
      repo: "r",
      octokit: client,
      submitReviewGuard: guard,
    });
    // Drive the registered tool the way the SDK's CallTool handler does, so
    // the zod defaults (e.g. side) apply exactly as they would in production.
    const internal = server as any;
    const tool = internal._registeredTools?.submit_review;
    expect(tool).toBeDefined();
    const call = async (args: Record<string, unknown>) => {
      const validated = await internal.validateToolInput(
        tool,
        args,
        "submit_review",
      );
      return internal.executeToolHandler(tool, validated, {});
    };

    const first = await call({ pr_number: 7, comments: [commentA] });
    expect(first.isError).toBeUndefined();
    expect(first.content[0].text).toContain("Submitted review 9001");

    const second = await call({ pr_number: 7, comments: [commentA] });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain(
      "already submitted as review 9001",
    );
    expect(calls.createReview).toHaveLength(1);
  });
});
