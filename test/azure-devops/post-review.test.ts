import { describe, expect, it } from "bun:test";
import { AzureDevopsClient } from "../../src/azure-devops/api/client";
import { postReview } from "../../src/azure-devops/operations/post-review";
import { buildUnifiedDiffIndex } from "../../src/core/review/validated/diff";
import type { ValidatedReviewComment } from "../../src/core/review/validated/parse";
import { createFakeAdo, json } from "./helpers";

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " line1",
  "-line2",
  "+line2 changed",
  "+added",
  " line3",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-remove me",
  "",
].join("\n");

const CHANGES = [
  { changeTrackingId: 1, item: { path: "/src/app.ts" }, changeType: "edit" },
  { changeTrackingId: 2, item: { path: "/src/gone.ts" }, changeType: "delete" },
];

function comment(
  over: Partial<ValidatedReviewComment>,
): ValidatedReviewComment {
  return {
    path: "src/app.ts",
    body: "[P1] Bug",
    line: 2,
    startLine: null,
    side: "RIGHT",
    old_path: null,
    old_line: null,
    ...over,
  };
}

function setup(respond?: (body: Record<string, unknown>) => Response) {
  const fake = createFakeAdo();
  let id = 100;
  fake.on("POST", "/pullRequests/17/threads", (req) =>
    respond
      ? respond(req.body as Record<string, unknown>)
      : json({ id: id++, comments: [{ id: 1 }] }),
  );
  const client = new AzureDevopsClient({
    collectionUri: "https://dev.azure.com/contoso",
    project: "proj",
    repositoryId: "repo",
    auth: { kind: "bearer", token: "t" },
    fetch: fake.fetch,
  });
  return { fake, client };
}

describe("postReview", () => {
  it("anchors a right-side finding with threadContext and iteration context", async () => {
    const { fake, client } = setup();
    const result = await postReview({
      client,
      pullRequestId: 17,
      iterationId: 3,
      changes: CHANGES,
      diffIndex: buildUnifiedDiffIndex(DIFF),
      comments: [comment({ line: 3 })],
    });
    expect(result).toEqual({ posted: 1, fallbackPosted: 0, failures: [] });
    expect(fake.requests[0]!.body).toEqual({
      comments: [
        { parentCommentId: 0, content: "[P1] Bug", commentType: "text" },
      ],
      status: "active",
      threadContext: {
        filePath: "/src/app.ts",
        rightFileStart: { line: 3, offset: 1 },
        rightFileEnd: { line: 3, offset: 1 },
      },
      pullRequestThreadContext: {
        changeTrackingId: 1,
        iterationContext: {
          firstComparingIteration: 3,
          secondComparingIteration: 3,
        },
      },
    });
  });

  it("sends a multi-line range and retries as one line when it is refused", async () => {
    let calls = 0;
    const { fake, client } = setup(() => {
      calls += 1;
      return calls === 1
        ? json({ message: "Invalid thread context" }, 400)
        : json({ id: 5, comments: [{ id: 1 }] });
    });
    const result = await postReview({
      client,
      pullRequestId: 17,
      iterationId: 3,
      changes: CHANGES,
      diffIndex: buildUnifiedDiffIndex(DIFF),
      comments: [comment({ startLine: 2, line: 3 })],
    });
    expect(result.posted).toBe(1);
    const contexts = fake.requests.map(
      (r) => (r.body as { threadContext: unknown }).threadContext,
    );
    expect(contexts).toEqual([
      {
        filePath: "/src/app.ts",
        rightFileStart: { line: 2, offset: 1 },
        rightFileEnd: { line: 3, offset: 1 },
      },
      {
        filePath: "/src/app.ts",
        rightFileStart: { line: 3, offset: 1 },
        rightFileEnd: { line: 3, offset: 1 },
      },
    ]);
  });

  it("anchors a left-side finding on a deleted file", async () => {
    const { fake, client } = setup();
    await postReview({
      client,
      pullRequestId: 17,
      iterationId: 3,
      changes: CHANGES,
      diffIndex: buildUnifiedDiffIndex(DIFF),
      comments: [
        comment({ path: "src/gone.ts", side: "LEFT", line: null, old_line: 1 }),
      ],
    });
    const body = fake.requests[0]!.body as Record<string, unknown>;
    expect(body.threadContext).toEqual({
      filePath: "/src/gone.ts",
      leftFileStart: { line: 1, offset: 1 },
      leftFileEnd: { line: 1, offset: 1 },
    });
    expect(
      (body.pullRequestThreadContext as { changeTrackingId: number })
        .changeTrackingId,
    ).toBe(2);
  });

  it("posts lines outside the diff as a general comment", async () => {
    const { fake, client } = setup();
    const result = await postReview({
      client,
      pullRequestId: 17,
      iterationId: 3,
      changes: CHANGES,
      diffIndex: buildUnifiedDiffIndex(DIFF),
      comments: [
        comment({ line: 40 }),
        comment({ path: "src/other.ts", line: 1 }),
      ],
    });
    expect(result).toEqual({ posted: 0, fallbackPosted: 2, failures: [] });
    for (const req of fake.requests) {
      const body = req.body as Record<string, unknown>;
      expect(body).not.toHaveProperty("threadContext");
      expect(body.status).toBe("active");
    }
    const first = (
      fake.requests[0]!.body as { comments: Array<{ content: string }> }
    ).comments[0]!.content;
    expect(first).toContain("`src/app.ts:40`");
    expect(first).toContain("[P1] Bug");
  });

  it("records a failure when inline and fallback posting both fail", async () => {
    const { client } = setup(() =>
      json(
        {
          message:
            "TF401027: You need the Git 'PullRequestContribute' permission",
        },
        403,
      ),
    );
    const result = await postReview({
      client,
      pullRequestId: 17,
      iterationId: 3,
      changes: CHANGES,
      diffIndex: buildUnifiedDiffIndex(DIFF),
      comments: [comment({ line: 2 })],
    });
    expect(result.posted).toBe(0);
    expect(result.fallbackPosted).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.error).toContain("TF401027");
    expect(result.failures[0]!.error).toContain(
      "general comment fallback failed",
    );
  });
});
