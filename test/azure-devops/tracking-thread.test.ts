import { describe, expect, it } from "bun:test";
import { AzureDevopsClient } from "../../src/azure-devops/api/client";
import {
  DROID_TRACKING_MARKER,
  DROID_TRACKING_PROPERTY,
  buildTrackingCommentBody,
  findTrackingThread,
  resolveOwnTrackingThread,
  resolveTrackingOwner,
  upsertTrackingThread,
} from "../../src/azure-devops/operations/tracking-thread";
import type { AdoComment, AdoThread } from "../../src/azure-devops/types";
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

const OWNER = "8a7b6c5d-build-service";
const owned = (over: Partial<AdoComment> = {}): AdoComment => ({
  id: 1,
  content: "hi",
  author: { id: OWNER, displayName: "Project Collection Build Service" },
  ...over,
});
const TAG = {
  [DROID_TRACKING_PROPERTY]: { $type: "System.String", $value: "1" },
};

describe("findTrackingThread", () => {
  const thread = (over: Partial<AdoThread>): AdoThread => ({
    id: 1,
    comments: [owned()],
    ...over,
  });

  it("finds this identity's thread by property", () => {
    expect(
      findTrackingThread(
        [
          thread({ id: 4 }),
          thread({
            id: 5,
            comments: [owned({ id: 9, content: "no marker" })],
            properties: TAG,
          }),
        ],
        OWNER,
      ),
    ).toEqual({ threadId: 5, commentId: 9 });
  });

  it("matches the identity case-insensitively", () => {
    expect(
      findTrackingThread(
        [thread({ id: 5, properties: TAG })],
        OWNER.toUpperCase(),
      ),
    ).toEqual({ threadId: 5, commentId: 1 });
  });

  it("falls back to the body marker and skips deleted threads/comments", () => {
    expect(
      findTrackingThread(
        [
          thread({
            id: 2,
            isDeleted: true,
            comments: [owned({ content: DROID_TRACKING_MARKER })],
          }),
          thread({
            id: 3,
            comments: [
              owned({ content: "old", isDeleted: true }),
              owned({ id: 2, content: `${DROID_TRACKING_MARKER}\nbody` }),
            ],
          }),
        ],
        OWNER,
      ),
    ).toEqual({ threadId: 3, commentId: 2 });
    expect(findTrackingThread([thread({})], OWNER)).toBeNull();
  });

  it("ignores a property set by another user", () => {
    const spoofed = thread({
      id: 6,
      properties: TAG,
      comments: [owned({ author: { id: "mallory" } })],
    });
    expect(findTrackingThread([spoofed], OWNER)).toBeNull();
  });

  it("ignores a marker pasted by another user", () => {
    const spoofed = thread({
      id: 7,
      comments: [
        owned({ author: { id: "mallory" }, content: DROID_TRACKING_MARKER }),
      ],
    });
    expect(findTrackingThread([spoofed], OWNER)).toBeNull();
  });

  it("adopts nothing when the identity is unknown", () => {
    expect(
      findTrackingThread([thread({ id: 5, properties: TAG })], null),
    ).toBeNull();
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
      ownerId: OWNER,
      body: "body",
    });
    expect(result).toEqual({ threadId: 71, commentId: 1, created: true });
    const sent = fake.requests[0]!.body as Record<string, unknown>;
    expect(sent).toEqual({
      comments: [{ parentCommentId: 0, content: "body", commentType: "text" }],
      properties: TAG,
    });
    expect(sent).not.toHaveProperty("status");
    expect(sent).not.toHaveProperty("threadContext");
  });

  it("edits this identity's tracking comment instead of creating one", async () => {
    const fake = createFakeAdo();
    fake.on("PATCH", "/pullRequests/17/threads/8/comments/3", () =>
      json({ id: 3 }),
    );
    const result = await upsertTrackingThread({
      client: client(fake),
      pullRequestId: 17,
      threads: [
        { id: 8, comments: [owned({ id: 3, content: DROID_TRACKING_MARKER })] },
      ],
      ownerId: OWNER,
      body: "new body",
    });
    expect(result).toEqual({ threadId: 8, commentId: 3, created: false });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.body).toEqual({ content: "new body" });
  });

  it("creates a new thread instead of editing a spoofed one", async () => {
    const fake = createFakeAdo();
    fake.on("POST", "/pullRequests/17/threads", () =>
      json({ id: 72, comments: [{ id: 1 }] }),
    );
    const result = await upsertTrackingThread({
      client: client(fake),
      pullRequestId: 17,
      threads: [
        {
          id: 8,
          properties: TAG,
          comments: [
            owned({
              id: 3,
              author: { id: "mallory" },
              content: DROID_TRACKING_MARKER,
            }),
          ],
        },
      ],
      ownerId: OWNER,
      body: "body",
    });
    expect(result).toEqual({ threadId: 72, commentId: 1, created: true });
    expect(fake.requests.map((r) => r.method)).toEqual(["POST"]);
  });
});

describe("resolveTrackingOwner", () => {
  it("reads the authenticated identity from unversioned connectionData", async () => {
    const fake = createFakeAdo();
    fake.on("GET", "/contoso/_apis/connectionData", () =>
      json({ authenticatedUser: { id: OWNER } }),
    );
    expect(await resolveTrackingOwner(client(fake))).toBe(OWNER);
    expect(fake.requests[0]!.url).toBe(
      "https://dev.azure.com/contoso/_apis/connectionData",
    );
  });

  it("returns null when the identity cannot be resolved", async () => {
    const fake = createFakeAdo();
    fake.on("GET", "/contoso/_apis/connectionData", () => json({}, 401));
    expect(await resolveTrackingOwner(client(fake))).toBeNull();
  });
});

describe("resolveOwnTrackingThread", () => {
  it("edits the hinted thread when this identity wrote it", async () => {
    const fake = createFakeAdo();
    fake.on("GET", "/pullRequests/17/threads/8", () =>
      json({ id: 8, properties: TAG, comments: [owned({ id: 3 })] }),
    );
    expect(
      await resolveOwnTrackingThread({
        client: client(fake),
        pullRequestId: 17,
        ownerId: OWNER,
        hint: { threadId: 8, commentId: 3 },
      }),
    ).toEqual({ threadId: 8, commentId: 3 });
  });

  it("refuses a hinted thread written by someone else and finds its own", async () => {
    const fake = createFakeAdo();
    fake.on("GET", "/pullRequests/17/threads/66", () =>
      json({
        id: 66,
        comments: [
          owned({ author: { id: "mallory" }, content: DROID_TRACKING_MARKER }),
        ],
      }),
    );
    fake.on("GET", "/pullRequests/17/threads", () =>
      json({
        value: [{ id: 8, properties: TAG, comments: [owned({ id: 3 })] }],
      }),
    );
    expect(
      await resolveOwnTrackingThread({
        client: client(fake),
        pullRequestId: 17,
        ownerId: OWNER,
        hint: { threadId: 66, commentId: 1 },
      }),
    ).toEqual({ threadId: 8, commentId: 3 });
  });

  it("returns null without an identity, so the caller creates a thread", async () => {
    const fake = createFakeAdo();
    expect(
      await resolveOwnTrackingThread({
        client: client(fake),
        pullRequestId: 17,
        ownerId: null,
        hint: { threadId: 8, commentId: 3 },
      }),
    ).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });
});
