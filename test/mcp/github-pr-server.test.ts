import { describe, expect, it } from "bun:test";
import {
  deletePullRequestComment,
  listReviewAndIssueComments,
  minimizeComment,
  replyToPullRequestComment,
  submitReviewWithComments,
  resolveReviewThread,
  type OctokitLike,
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
