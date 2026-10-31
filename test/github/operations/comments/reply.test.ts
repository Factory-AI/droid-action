import { describe, expect, test } from "bun:test";
import { replyToPullRequestComment } from "../../../../src/github/operations/comments/reply";

function fixture(failures: unknown[] = []) {
  const replies: unknown[] = [],
    comments: unknown[] = [];
  const send = async (calls: unknown[], value: unknown) => {
    calls.push(value);
    if (failures.length) throw failures.shift();
  };
  return {
    replies,
    comments,
    octokit: {
      rest: {
        pulls: {
          createReplyForReviewComment: (value: unknown) => send(replies, value),
        },
        issues: { createComment: (value: unknown) => send(comments, value) },
      },
    },
  };
}
const options = {
  owner: "owner",
  repo: "repo",
  prNumber: 12,
  commentId: 100,
  body: "answer",
};
describe("shared non-idempotent comment reply transport", () => {
  test.each(["review", "issue"] as const)(
    "keeps the selected %s destination and redacts the body",
    async (type) => {
      const f = fixture();
      const token = `ghp_${"a".repeat(36)}`;
      await replyToPullRequestComment({
        ...options,
        type,
        octokit: f.octokit,
        body: `answer ${token}`,
      });
      const calls = type === "review" ? f.replies : f.comments;
      expect(calls).toEqual([
        type === "review"
          ? {
              owner: "owner",
              repo: "repo",
              pull_number: 12,
              comment_id: 100,
              body: "answer [REDACTED_GITHUB_TOKEN]",
            }
          : {
              owner: "owner",
              repo: "repo",
              issue_number: 12,
              body: "answer [REDACTED_GITHUB_TOKEN]",
            },
      ]);
      expect(type === "review" ? f.comments : f.replies).toHaveLength(0);
    },
  );
  test.each(["review", "issue"] as const)(
    "retries only a rejected 429 for %s",
    async (type) => {
      const f = fixture([
        Object.assign(new Error("rate limited"), { status: 429 }),
      ]);
      await replyToPullRequestComment({ ...options, type, octokit: f.octokit });
      const calls = type === "review" ? f.replies : f.comments;
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual(calls[0]);
    },
  );
  test.each([
    Object.assign(new Error("server response unknown"), { status: 500 }),
    Object.assign(new Error("forbidden"), { status: 403 }),
    Object.assign(
      new Error("string status is not an explicit HTTP rejection"),
      { status: "429" },
    ),
    new Error("connection lost after write"),
    { status: 429 },
  ])(
    "does not retry an ambiguous or non-retryable error %o",
    async (failure) => {
      const f = fixture([failure, failure, failure]);
      await expect(
        replyToPullRequestComment({
          ...options,
          type: "review",
          octokit: f.octokit,
        }),
      ).rejects.toThrow();
      expect(f.replies).toHaveLength(1);
      expect(f.comments).toHaveLength(0);
    },
  );
  test("bounds repeated rejected 429s to three identical attempts", async () => {
    const failure = Object.assign(new Error("rate limited"), { status: 429 });
    const f = fixture([failure, failure, failure]);
    await expect(
      replyToPullRequestComment({
        ...options,
        type: "issue",
        octokit: f.octokit,
      }),
    ).rejects.toThrow("rate limited");
    expect(f.comments).toHaveLength(3);
    expect(f.comments[0]).toEqual(f.comments[2]);
    expect(f.replies).toHaveLength(0);
  });
  test("redacts a transport error before propagating it", async () => {
    const f = fixture([new Error(`connection failed ghp_${"b".repeat(36)}`)]);
    await expect(
      replyToPullRequestComment({
        ...options,
        type: "review",
        octokit: f.octokit,
      }),
    ).rejects.toThrow("connection failed [REDACTED_GITHUB_TOKEN]");
    expect(f.replies).toHaveLength(1);
  });
});
