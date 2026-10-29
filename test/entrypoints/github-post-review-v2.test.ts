import { describe, expect, it, mock } from "bun:test";
import {
  MAX_GITHUB_REVIEW_BODY_BYTES,
  MAX_GITHUB_REVIEW_COMMENTS,
  fallbackReviewBody,
  postGitHubReview,
  prepareGitHubReview,
  type GitHubReviewClient,
} from "../../src/entrypoints/github-post-review-v2";
import { buildUnifiedDiffIndex } from "../../src/core/review/validated/diff";
import type { ValidatedReviewComment } from "../../src/core/review/validated/parse";
import { DroidRunType } from "../../src/run-type";

const DIFF = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -8,5 +8,5 @@
 a
 b
+c
 d
-e
 f
`;

const comment = (
  overrides: Partial<ValidatedReviewComment> = {},
): ValidatedReviewComment => ({
  path: "src/x.ts",
  body: "[P1] Finding",
  line: 10,
  startLine: null,
  side: "RIGHT",
  old_path: null,
  old_line: null,
  ...overrides,
});

describe("prepareGitHubReview", () => {
  it("keeps valid RIGHT/LEFT anchors and moves out-of-diff lines to the body", () => {
    const prepared = prepareGitHubReview(
      [
        comment(),
        comment({ side: "LEFT", line: null, old_line: 11 }),
        comment({ path: "missing.ts", line: 99 }),
      ],
      buildUnifiedDiffIndex(DIFF),
    );

    expect(prepared.inline).toEqual([
      {
        path: "src/x.ts",
        body: "[P1] Finding",
        line: 10,
        side: "RIGHT",
      },
      {
        path: "src/x.ts",
        body: "[P1] Finding",
        line: 11,
        side: "LEFT",
      },
    ]);
    expect(prepared.fallback).toHaveLength(1);
    expect(prepared.fallback[0]!.reason).toContain("not part of the PR diff");
  });

  it("caps inline comments at GitHub's per-review limit", () => {
    const comments = Array.from(
      { length: MAX_GITHUB_REVIEW_COMMENTS + 2 },
      (_, index) =>
        comment({
          line: 10,
          body: `[P1] Finding ${index}`,
        }),
    );
    const prepared = prepareGitHubReview(comments, buildUnifiedDiffIndex(DIFF));

    expect(prepared.inline).toHaveLength(MAX_GITHUB_REVIEW_COMMENTS);
    expect(prepared.fallback).toHaveLength(2);
  });
});

describe("fallbackReviewBody", () => {
  it("includes each location, finding, and fallback reason", () => {
    const body = fallbackReviewBody([
      { comment: comment(), reason: "line is not part of the PR diff" },
    ]);

    expect(body).toContain("## Findings without inline anchors");
    expect(body).toContain("`src/x.ts:10`");
    expect(body).toContain("[P1] Finding");
    expect(body).toContain("line is not part of the PR diff");
  });
});

describe("postGitHubReview", () => {
  it("creates one nonempty review and preserves fallback findings for the sticky summary", async () => {
    const createReview = mock(async (_payload: any) => ({
      data: { id: 123 },
    }));
    const client = {
      rest: { pulls: { createReview } },
    } as GitHubReviewClient;

    const result = await postGitHubReview({
      client,
      owner: "o",
      repo: "r",
      prNumber: 7,
      comments: [comment(), comment({ path: "missing.ts", line: 99 })],
      diff: DIFF,
    });

    expect(result).toMatchObject({
      reviewId: 123,
      posted: 1,
      fallbackPosted: 1,
      failures: [],
    });
    expect(createReview).toHaveBeenCalledTimes(1);
    const payload = createReview.mock.calls[0]![0] as any;
    expect(payload.comments).toHaveLength(1);
    expect(payload.body).toContain("Droid found 2 issues");
    expect(payload.body).not.toContain("missing.ts:99");
    expect(
      result.findings?.find((finding) => finding.path === "missing.ts")
        ?.outside_diff,
    ).toBe(true);
    expect(payload.comments[0].body).toContain("droid-finding:v1");
    expect(payload.comments[0].body).toContain('alt="P1"');
    expect(payload.event).toBe("COMMENT");
    // Without a validated SHA the poster must not invent one.
    expect(payload).not.toHaveProperty("commit_id");
  });

  it("pins the review to the validated head commit", async () => {
    const createReview = mock(async (_payload: any) => ({
      data: { id: 124 },
    }));
    const client = {
      rest: { pulls: { createReview } },
    } as GitHubReviewClient;

    await postGitHubReview({
      client,
      owner: "o",
      repo: "r",
      prNumber: 7,
      comments: [comment()],
      diff: DIFF,
      commitId: "0123456789abcdef0123456789abcdef01234567",
    });

    expect(createReview).toHaveBeenCalledTimes(1);
    expect((createReview.mock.calls[0]![0] as any).commit_id).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
  });

  it("tags inline comments with the review run type", async () => {
    const createReview = mock(async (_payload: any) => ({
      data: { id: 125 },
    }));
    const client = {
      rest: { pulls: { createReview } },
    } as GitHubReviewClient;

    await postGitHubReview({
      client,
      owner: "o",
      repo: "r",
      prNumber: 7,
      comments: [comment({ body: "[P1] [security] Finding" })],
      diff: DIFF,
      runType: DroidRunType.SecurityReview,
    });

    expect((createReview.mock.calls[0]![0] as any).comments[0].body).toEndWith(
      "<!-- factory-pr-inline-comment: run-type=droid-security-review -->",
    );
  });

  it("preserves a valid multi-line anchor in the single API call", async () => {
    const createReview = mock(async (_payload: any) => ({
      data: { id: 456 },
    }));
    const client = {
      rest: { pulls: { createReview } },
    } as GitHubReviewClient;

    const result = await postGitHubReview({
      client,
      owner: "o",
      repo: "r",
      prNumber: 7,
      comments: [comment({ line: 11, startLine: 9 })],
      diff: DIFF,
    });

    expect(result.posted).toBe(1);
    expect(createReview).toHaveBeenCalledTimes(1);
    expect((createReview.mock.calls[0]![0] as any).comments[0]).toMatchObject({
      start_line: 9,
      start_side: "RIGHT",
    });
  });

  it("does not retry when GitHub rejects the review", async () => {
    const createReview = mock(async (_payload: any) => {
      throw new Error("ambiguous API failure");
    });
    const client = {
      rest: { pulls: { createReview } },
    } as GitHubReviewClient;

    const result = await postGitHubReview({
      client,
      owner: "o",
      repo: "r",
      prNumber: 7,
      comments: [comment()],
      diff: DIFF,
    });

    expect(result.posted).toBe(0);
    expect(result.fallbackPosted).toBe(0);
    expect(result.failures[0]!.error).toBe("ambiguous API failure");
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it("never submits an outside-diff-only review, even for a large fallback", async () => {
    const createReview = mock(async (_payload: any) => ({
      data: { id: 789 },
    }));
    const client = {
      rest: { pulls: { createReview } },
    } as GitHubReviewClient;

    const result = await postGitHubReview({
      client,
      owner: "o",
      repo: "r",
      prNumber: 7,
      comments: [
        comment({
          path: "missing.ts",
          body: "x".repeat(MAX_GITHUB_REVIEW_BODY_BYTES),
        }),
      ],
      diff: DIFF,
    });

    expect(result.failures).toHaveLength(0);
    expect(result.fallbackPosted).toBe(1);
    expect(result.findings?.[0]?.outside_diff).toBe(true);
    expect(createReview).not.toHaveBeenCalled();
  });
});
