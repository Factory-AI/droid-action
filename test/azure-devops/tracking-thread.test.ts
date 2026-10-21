import { describe, expect, it } from "bun:test";
import { AzureDevopsClient } from "../../src/azure-devops/api/client";
import {
  DROID_TRACKING_MARKER,
  DROID_TRACKING_PROPERTY,
  buildTrackingCommentBody,
  findTrackingThread,
  upsertTrackingThread,
} from "../../src/azure-devops/operations/tracking-thread";
import type { AdoThread } from "../../src/azure-devops/types";
import { createFakeAdo, json } from "./helpers";

function client(fake: ReturnType<typeof createFakeAdo>) {
  return new AzureDevopsClient({
    collectionUri: "https://dev.azure.com/contoso",
    project: "proj",
    repositoryId: "repo",
    auth: { kind: "bearer", token: "t" },
    fetch: fake.fetch,
  });
}

describe("buildTrackingCommentBody", () => {
  it("renders state, links, counts, and telemetry", () => {
    const body = buildTrackingCommentBody({
      state: "success",
      pipelineUrl: "https://dev.azure.com/c/p/_build/results?buildId=1",
      jobUrl:
        "https://dev.azure.com/c/p/_build/results?buildId=1&view=logs&j=x",
      triggerUsername: "Ada Lovelace",
      securityReviewRan: true,
      review: {
        posted: 2,
        fallbackPosted: 1,
        failed: 1,
        skipped: 0,
        summaryBody: "Two bugs.",
      },
      telemetry: {
        totalNumTurns: 12,
        totalDurationMs: 61_000,
        pass1SessionId: "s1",
      },
    });
    expect(body.startsWith(DROID_TRACKING_MARKER)).toBe(true);
    expect(body).toContain("Droid finished reviewing this pull request");
    expect(body).toContain("security%20review-enabled");
    expect(body).toContain("Triggered by Ada Lovelace.");
    expect(body).toContain(
      "Build: https://dev.azure.com/c/p/_build/results?buildId=1",
    );
    expect(body).toContain("Two bugs.");
    expect(body).toContain("2 inline comments posted");
    expect(body).toContain(
      "1 posted as a general comment (line outside the diff)",
    );
    expect(body).toContain("1 could not be posted");
    expect(body).not.toContain("skipped");
    expect(body).toContain("12 turns");
    expect(body).toContain("- Pass 1: `s1`");
  });

  it("only includes error details on failure", () => {
    expect(
      buildTrackingCommentBody({ state: "failure", errorDetails: "boom" }),
    ).toContain("boom");
    expect(
      buildTrackingCommentBody({ state: "success", errorDetails: "boom" }),
    ).not.toContain("boom");
  });
});

describe("findTrackingThread", () => {
  const thread = (over: Partial<AdoThread>): AdoThread => ({
    id: 1,
    comments: [{ id: 1, content: "hi" }],
    ...over,
  });

  it("finds the thread by property", () => {
    expect(
      findTrackingThread([
        thread({ id: 4 }),
        thread({
          id: 5,
          comments: [{ id: 9, content: "no marker" }],
          properties: {
            [DROID_TRACKING_PROPERTY]: { $type: "System.String", $value: "1" },
          },
        }),
      ]),
    ).toEqual({ threadId: 5, commentId: 9 });
  });

  it("falls back to the body marker and skips deleted threads/comments", () => {
    expect(
      findTrackingThread([
        thread({
          id: 2,
          isDeleted: true,
          comments: [{ id: 1, content: DROID_TRACKING_MARKER }],
        }),
        thread({
          id: 3,
          comments: [
            { id: 1, content: "old", isDeleted: true },
            { id: 2, content: `${DROID_TRACKING_MARKER}\nbody` },
          ],
        }),
      ]),
    ).toEqual({ threadId: 3, commentId: 2 });
    expect(findTrackingThread([thread({})])).toBeNull();
  });
});

describe("upsertTrackingThread", () => {
  it("creates a status-less general thread tagged with the property", async () => {
    const fake = createFakeAdo();
    fake.on("POST", "/pullRequests/17/threads", () =>
      json({ id: 71, comments: [{ id: 1, parentCommentId: 0, content: "b" }] }),
    );
    const result = await upsertTrackingThread({
      client: client(fake),
      pullRequestId: 17,
      threads: [],
      body: "body",
    });
    expect(result).toEqual({ threadId: 71, commentId: 1, created: true });
    const sent = fake.requests[0]!.body as Record<string, unknown>;
    expect(sent).toEqual({
      comments: [{ parentCommentId: 0, content: "body", commentType: "text" }],
      properties: {
        [DROID_TRACKING_PROPERTY]: { $type: "System.String", $value: "1" },
      },
    });
    expect(sent).not.toHaveProperty("status");
    expect(sent).not.toHaveProperty("threadContext");
  });

  it("edits the existing tracking comment instead of creating one", async () => {
    const fake = createFakeAdo();
    fake.on("PATCH", "/pullRequests/17/threads/8/comments/3", () =>
      json({ id: 3 }),
    );
    const result = await upsertTrackingThread({
      client: client(fake),
      pullRequestId: 17,
      threads: [
        { id: 8, comments: [{ id: 3, content: DROID_TRACKING_MARKER }] },
      ],
      body: "new body",
    });
    expect(result).toEqual({ threadId: 8, commentId: 3, created: false });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.body).toEqual({ content: "new body" });
  });
});
