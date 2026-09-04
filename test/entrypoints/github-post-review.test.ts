import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  MAX_GITHUB_REVIEW_BODY_BYTES,
  MAX_GITHUB_REVIEW_COMMENTS,
  fallbackReviewBody,
  postGitHubReview,
  prepareGitHubReview,
  run,
  type GitHubReviewClient,
} from "../../src/entrypoints/github-post-review";
import { buildUnifiedDiffIndex } from "../../src/core/review/validated/diff";
import type { ValidatedReviewComment } from "../../src/core/review/validated/parse";
import { createMockContext } from "../mockContext";

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
  it("creates one review containing inline and body-fallback findings", async () => {
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

    expect(result).toEqual({
      reviewId: 123,
      posted: 1,
      fallbackPosted: 1,
      failures: [],
    });
    expect(createReview).toHaveBeenCalledTimes(1);
    const payload = createReview.mock.calls[0]![0] as any;
    expect(payload.comments).toHaveLength(1);
    expect(payload.body).toContain("missing.ts:99");
    expect(payload.event).toBe("COMMENT");
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

  it("does not send a fallback body over GitHub's size budget", async () => {
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

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.error).toContain("review body budget");
    expect(createReview).not.toHaveBeenCalled();
  });
});

describe("github-post-review entrypoint", () => {
  const ENV_KEYS = [
    "RUNNER_TEMP",
    "REVIEW_VALIDATED_PATH",
    "REVIEW_DIFF_PATH",
    "REVIEW_POST_RESULTS_PATH",
    "GITHUB_TOKEN",
  ] as const;
  let savedEnv: Record<string, string | undefined>;
  let tmpDir: string;

  beforeEach(async () => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-post-review-"));
    process.env.RUNNER_TEMP = tmpDir;
    await fs.mkdir(path.join(tmpDir, "droid-prompts"), { recursive: true });
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads validated output and diff, posts once, and writes result counts", async () => {
    const prompts = path.join(tmpDir, "droid-prompts");
    await fs.writeFile(path.join(prompts, "pr.diff"), DIFF);
    await fs.writeFile(
      path.join(prompts, "review_validated.json"),
      JSON.stringify({
        version: 1,
        results: [
          { status: "approved", comment: comment() },
          {
            status: "rejected",
            comment: comment({ body: "[P2] Rejected" }),
          },
        ],
        reviewSummary: { body: "One issue should be fixed." },
      }),
    );

    const createReview = mock(async (_payload: any) => ({
      data: { id: 999 },
    }));
    const context = createMockContext({
      isPR: true,
      entityNumber: 42,
      repository: { owner: "o", repo: "r", full_name: "o/r" },
    });

    const results = await run({
      context,
      client: {
        rest: { pulls: { createReview } },
      },
    });

    expect(createReview).toHaveBeenCalledTimes(1);
    expect(results).toEqual({
      posted: 1,
      fallbackPosted: 0,
      approved: 1,
      rejected: 1,
      failed: 0,
      skipped: 0,
      summaryBody: "One issue should be fixed.",
      failures: [],
    });
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(prompts, "review_post_results.json"),
          "utf8",
        ),
      ),
    ).toEqual(results);
  });

  it("does not require a diff, token, or client when nothing is approved", async () => {
    const prompts = path.join(tmpDir, "droid-prompts");
    await fs.writeFile(
      path.join(prompts, "review_validated.json"),
      JSON.stringify({
        version: 1,
        results: [
          {
            status: "rejected",
            comment: comment({ body: "[P2] Rejected" }),
          },
        ],
        reviewSummary: { body: "LGTM — no issues found." },
      }),
    );

    const results = await run({
      context: createMockContext({ isPR: true, entityNumber: 42 }),
    });

    expect(results.posted).toBe(0);
    expect(results.rejected).toBe(1);
    expect(results.summaryBody).toBe("LGTM — no issues found.");
  });
});
