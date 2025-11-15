import { describe, expect, it } from "bun:test";
import {
  cleanDescription,
  createGitHubPRServer,
  extractIssueReferences,
  handleUpdatePRDescription,
  mergeDescriptions,
} from "./github-pr-server";

type MockCall<TArgs extends unknown[]> = {
  args: TArgs;
};

function createMockOctokit(existingBody = "") {
  const updateCalls: MockCall<[any]>[] = [];
  const getCalls: MockCall<[any]>[] = [];

  return {
    rest: {
      pulls: {
        update: async (params: any) => {
          updateCalls.push({ args: [params] });
          return { data: {} };
        },
        get: async (params: any) => {
          getCalls.push({ args: [params] });
          return { data: { body: existingBody } };
        },
        listReviewComments: async () => ({ data: [] }),
        createReview: async () => ({ data: { id: 1 } }),
        deleteReviewComment: async () => ({}),
        getReviewComment: async () => ({ data: { node_id: "node" } }),
        createReplyForReviewComment: async () => ({ data: { id: 1 } }),
      },
      issues: {
        listComments: async () => ({ data: [] }),
        deleteComment: async () => ({}),
        getComment: async () => ({ data: { node_id: "node" } }),
        createComment: async () => ({ data: { id: 1 } }),
      },
    },
    __calls: {
      update: updateCalls,
      get: getCalls,
    },
  } as const;
}

describe("github-pr-server", () => {
  it("should remove @droid fill placeholder in cleanDescription", () => {
    const input = "## Summary\n@droid fill\nActual content";
    expect(cleanDescription(input)).toBe("## Summary\nActual content");
  });

  it("should extract issue references", () => {
    const refs = extractIssueReferences("Fixes #123 and closes #456");
    expect(refs).toEqual(["Fixes #123", "closes #456"]);
  });

  it("should merge descriptions preserving issue references", () => {
    const existing = "Existing body\nFixes #123";
    const generated = "## Summary\nNew content";
    const merged = mergeDescriptions(existing, generated);
    expect(merged).toContain("New content");
    expect(merged).toContain("Fixes #123");
  });

  it("should update PR description in replace mode", async () => {
    const octokit = createMockOctokit();

    const updated = await handleUpdatePRDescription({
      owner: "test-owner",
      repo: "test-repo",
      prNumber: 123,
      body: "## Description\n@droid fill\nActual content",
      mode: "replace",
      octokit,
    });

    expect(updated).toBe("## Description\nActual content");
    expect(octokit.__calls.get.length).toBe(0);
    expect(octokit.__calls.update[0]?.args[0].body).toBe(updated);
  });

  it("should merge with existing description in merge mode", async () => {
    const octokit = createMockOctokit("Existing content\nFixes #456");

    const updated = await handleUpdatePRDescription({
      owner: "test-owner",
      repo: "test-repo",
      prNumber: 123,
      body: "## New Section\nNew content",
      mode: "merge",
      octokit,
    });

    expect(octokit.__calls.get.length).toBe(1);
    expect(updated).toContain("New content");
    expect(updated).toContain("Fixes #456");
    expect(octokit.__calls.update[0]?.args[0].body).toBe(updated);
  });

  it("should create server with tool", () => {
    const octokit = createMockOctokit();
    const server = createGitHubPRServer({
      owner: "test-owner",
      repo: "test-repo",
      octokit,
    });

    expect(server).toBeDefined();
  });
});
