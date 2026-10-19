import { afterEach, describe, expect, it } from "bun:test";
import {
  BitbucketDataCenterClient,
  dcDiffToUnified,
} from "../../src/bitbucket/api/datacenter";
import { BitbucketApiError } from "../../src/bitbucket/api/http";
import { buildUnifiedDiffIndex } from "../../src/core/review/validated/diff";
import {
  APP_TS_DC_DIFF,
  APP_TS_DIFF,
  json,
  notFound,
  startFakeServer,
  type FakeServer,
} from "./fake-server";

const AUTH = { header: "Bearer dc-secret" };
const REPO = "/bitbucket/rest/api/1.0/projects/PROJ/repos/my-repo";
const PR = `${REPO}/pull-requests/12`;

let server: FakeServer;
afterEach(() => server?.stop());

function client() {
  return new BitbucketDataCenterClient({
    auth: AUTH,
    // Context path, as on instances served under /bitbucket.
    serverUrl: `${server.url}/bitbucket/`,
    projectKey: "PROJ",
    repoSlug: "my-repo",
    prId: 12,
    retryDelayMs: 0,
  });
}

describe("dcDiffToUnified", () => {
  it("renders the structured diff as a unified diff the line index understands", () => {
    const unified = dcDiffToUnified([APP_TS_DC_DIFF]);
    const expected = APP_TS_DIFF.replace("index 1111111..2222222 100644\n", "");
    expect(unified).toBe(expected);

    const index = buildUnifiedDiffIndex(unified).get("src/app.ts")!;
    expect(index.newLines.get(3)).toBe("added");
    expect(index.newLines.get(4)).toBe(3);
    expect(index.oldLines.get(2)).toBe("removed");
  });

  it("handles added, deleted, renamed and binary files", () => {
    const unified = dcDiffToUnified([
      {
        source: null,
        destination: { toString: "new.txt" },
        hunks: [
          {
            sourceLine: 0,
            sourceSpan: 0,
            destinationLine: 1,
            destinationSpan: 1,
            segments: [
              {
                type: "ADDED",
                lines: [{ source: 0, destination: 1, line: "hi" }],
              },
            ],
          },
        ],
      },
      { source: { toString: "gone.txt" }, destination: null, hunks: [] },
      {
        source: { toString: "old/name.ts" },
        destination: { toString: "new/name.ts" },
        hunks: [],
      },
      {
        source: { toString: "logo.png" },
        destination: { toString: "logo.png" },
        binary: true,
      },
    ]);

    expect(unified.split("\n")).toEqual([
      "diff --git a/new.txt b/new.txt",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,1 @@",
      "+hi",
      "diff --git a/gone.txt b/gone.txt",
      "--- a/gone.txt",
      "+++ /dev/null",
      "diff --git a/old/name.ts b/new/name.ts",
      "--- a/old/name.ts",
      "+++ b/new/name.ts",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ]);
    expect(buildUnifiedDiffIndex(unified).get("new.txt")!.newLines.get(1)).toBe(
      "added",
    );
  });

  it("is empty for no changes", () => {
    expect(dcDiffToUnified([])).toBe("");
  });
});

describe("BitbucketDataCenterClient", () => {
  it("fetches and normalizes a pull request under a context path", async () => {
    server = startFakeServer((req) =>
      req.path === PR
        ? json({
            id: 12,
            version: 3,
            title: "Add c",
            description: "Adds c",
            state: "OPEN",
            draft: false,
            author: { user: { name: "ada", displayName: "Ada" } },
            fromRef: {
              id: "refs/heads/feature/c",
              displayId: "feature/c",
              latestCommit: "a".repeat(40),
            },
            toRef: {
              id: "refs/heads/main",
              displayId: "main",
              latestCommit: "b".repeat(40),
            },
            links: {
              self: [
                {
                  href: "https://bb.example.com/projects/PROJ/repos/my-repo/pull-requests/12",
                },
              ],
            },
          })
        : notFound(),
    );

    const pr = await client().getPullRequest();

    expect(server.requests[0]!.headers.authorization).toBe("Bearer dc-secret");
    expect(pr).toEqual({
      id: 12,
      title: "Add c",
      description: "Adds c",
      draft: false,
      sourceBranch: "feature/c",
      targetBranch: "main",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      webUrl:
        "https://bb.example.com/projects/PROJ/repos/my-repo/pull-requests/12",
    });
  });

  it("requests the structured diff and converts it", async () => {
    server = startFakeServer(() =>
      json({
        fromHash: "a",
        toHash: "b",
        contextLines: 3,
        diffs: [APP_TS_DC_DIFF],
        truncated: false,
      }),
    );
    const diff = await client().getDiff();
    expect(server.requests[0]!.path).toBe(
      `${PR}/diff?contextLines=3&withComments=false`,
    );
    expect(diff.text).toContain("+const c = 4;");
    expect(diff.truncated).toBe(false);
  });

  it.each([
    ["the whole response", { diffs: [APP_TS_DC_DIFF], truncated: true }],
    ["one file", { diffs: [{ ...APP_TS_DC_DIFF, truncated: true }] }],
    [
      "one hunk",
      {
        diffs: [
          {
            ...APP_TS_DC_DIFF,
            hunks: [{ ...APP_TS_DC_DIFF.hunks![0]!, truncated: true }],
          },
        ],
      },
    ],
  ])("reports a diff the server truncated in %s", async (_label, body) => {
    server = startFakeServer(() => json(body));
    const diff = await client().getDiff();
    expect(diff.truncated).toBe(true);
    expect(diff.text).toContain("+const c = 4;");
  });

  it("pages through activities with start/nextPageStart and keeps only comments", async () => {
    server = startFakeServer((_req, url) => {
      if (url.pathname !== `${PR}/activities`) return notFound();
      const start = Number(url.searchParams.get("start"));
      if (start === 0) {
        return json({
          size: 2,
          limit: 100,
          isLastPage: false,
          start: 0,
          nextPageStart: 2,
          values: [
            {
              id: 100,
              action: "COMMENTED",
              commentAction: "ADDED",
              comment: {
                id: 1,
                version: 0,
                text: "top",
                author: { name: "ada" },
                createdDate: 1700000000000,
                comments: [
                  { id: 2, version: 0, text: "reply", author: { name: "bob" } },
                ],
              },
            },
            { id: 101, action: "APPROVED" },
          ],
        });
      }
      return json({
        size: 1,
        limit: 100,
        isLastPage: true,
        start: 2,
        values: [
          {
            id: 102,
            action: "COMMENTED",
            commentAction: "ADDED",
            comment: { id: 3, version: 1, text: "inline" },
            commentAnchor: { path: "src/app.ts", line: 3, lineType: "ADDED" },
          },
          {
            id: 103,
            action: "COMMENTED",
            commentAction: "EDITED",
            comment: { id: 3, version: 1, text: "inline" },
          },
        ],
      });
    });

    const comments = await client().listComments();

    expect(server.requests.map((r) => r.path)).toEqual([
      `${PR}/activities?start=0&limit=100`,
      `${PR}/activities?start=2&limit=100`,
    ]);
    expect(comments).toEqual([
      {
        id: 1,
        body: "top",
        author: "ada",
        createdAt: new Date(1700000000000).toISOString(),
        path: null,
        line: null,
        parentId: null,
      },
      {
        id: 2,
        body: "reply",
        author: "bob",
        createdAt: null,
        path: null,
        line: null,
        parentId: 1,
      },
      {
        id: 3,
        body: "inline",
        author: null,
        createdAt: null,
        path: "src/app.ts",
        line: 3,
        parentId: null,
      },
    ]);
  });

  it("creates comments with `text`", async () => {
    server = startFakeServer(() =>
      json({ id: 9, version: 0, text: "hi" }, 201),
    );
    const created = await client().createComment("hi");
    expect(created.id).toBe(9);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: `${PR}/comments`,
      body: { text: "hi" },
    });
  });

  it("updates a comment with its current version", async () => {
    server = startFakeServer((req) =>
      req.method === "GET"
        ? json({ id: 9, version: 4, text: "old" })
        : json({ id: 9, version: 5, text: req.body.text }),
    );
    await client().updateComment(9, "new");
    expect(server.requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ["GET", `${PR}/comments/9`, null],
      ["PUT", `${PR}/comments/9`, { text: "new", version: 4 }],
    ]);
  });

  it("refetches the version and retries once on a 409 conflict", async () => {
    let version = 4;
    let puts = 0;
    server = startFakeServer((req) => {
      if (req.method === "GET") return json({ id: 9, version, text: "x" });
      puts += 1;
      if (puts === 1) {
        version = 5; // someone else edited in between
        return json(
          {
            errors: [
              {
                message:
                  "You are attempting to modify a comment based on out-of-date information.",
                exceptionName:
                  "com.atlassian.bitbucket.comment.CommentOutOfDateException",
              },
            ],
          },
          409,
        );
      }
      return json({ id: 9, version: 6, text: req.body.text });
    });

    await client().updateComment(9, "new");

    const putBodies = server.requests
      .filter((r) => r.method === "PUT")
      .map((r) => r.body);
    expect(putBodies).toEqual([
      { text: "new", version: 4 },
      { text: "new", version: 5 },
    ]);
  });

  it("gives up after a second 409", async () => {
    server = startFakeServer((req) =>
      req.method === "GET"
        ? json({ id: 9, version: 1, text: "x" })
        : json({ errors: [{ message: "out-of-date" }] }, 409),
    );
    const error = await client()
      .updateComment(9, "new")
      .catch((e) => e);
    expect(error).toBeInstanceOf(BitbucketApiError);
    expect(error.message).toContain("Bitbucket API 409");
    expect(error.message).toContain("out-of-date");
    expect(server.requests.filter((r) => r.method === "PUT")).toHaveLength(2);
  });

  it("anchors inline comments with lineType, fileType and diffType", async () => {
    server = startFakeServer(() => json({ id: 1, version: 0, text: "x" }, 201));
    const c = client();

    await c.createInlineComment("added", {
      path: "src/app.ts",
      oldPath: "src/app.ts",
      line: 3,
      lineType: "ADDED",
      startLine: 2,
    });
    await c.createInlineComment("removed", {
      path: "src/app.ts",
      oldPath: null,
      line: 2,
      lineType: "REMOVED",
      startLine: null,
    });
    await c.createInlineComment("context in renamed file", {
      path: "src/new.ts",
      oldPath: "src/old.ts",
      line: 4,
      lineType: "CONTEXT",
      startLine: null,
    });

    expect(server.requests.map((r) => r.body)).toEqual([
      {
        text: "added",
        anchor: {
          diffType: "EFFECTIVE",
          path: "src/app.ts",
          line: 3,
          lineType: "ADDED",
          fileType: "TO",
        },
      },
      {
        text: "removed",
        anchor: {
          diffType: "EFFECTIVE",
          path: "src/app.ts",
          line: 2,
          lineType: "REMOVED",
          fileType: "FROM",
        },
      },
      {
        text: "context in renamed file",
        anchor: {
          diffType: "EFFECTIVE",
          path: "src/new.ts",
          srcPath: "src/old.ts",
          line: 4,
          lineType: "CONTEXT",
          fileType: "TO",
        },
      },
    ]);
  });

  it("pins anchors to the reviewed commits when they are known", async () => {
    server = startFakeServer(() => json({ id: 1, version: 0, text: "x" }, 201));
    await client().createInlineComment("added", {
      path: "src/app.ts",
      oldPath: null,
      line: 3,
      lineType: "ADDED",
      startLine: null,
      diffRefs: { fromHash: "b".repeat(40), toHash: "a".repeat(40) },
    });
    expect(server.requests[0]!.body.anchor).toEqual({
      diffType: "EFFECTIVE",
      path: "src/app.ts",
      line: 3,
      lineType: "ADDED",
      fileType: "TO",
      fromHash: "b".repeat(40),
      toHash: "a".repeat(40),
    });
  });

  const STATUS = {
    key: "droid-review",
    state: "SUCCESSFUL",
    name: "Droid code review",
    url: "https://jenkins/job/1",
    description: "Droid review finished",
    ref: "refs/heads/feature/x",
  } as const;
  const BASE_BODY = {
    key: "droid-review",
    state: "SUCCESSFUL",
    name: "Droid code review",
    url: "https://jenkins/job/1",
    description: "Droid review finished",
  };

  it("posts build statuses with the parent and ref that Required builds match", async () => {
    server = startFakeServer(() => new Response(null, { status: 204 }));
    await client().setBuildStatus("a".repeat(40), STATUS);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: `${REPO}/commits/${"a".repeat(40)}/builds`,
    });
    expect(server.requests[0]!.body).toEqual({
      ...BASE_BODY,
      parent: "droid-review",
      ref: "refs/heads/feature/x",
    });
  });

  it("retries without parent and ref when an older server rejects them", async () => {
    server = startFakeServer((req) =>
      req.body.parent
        ? json({ errors: [{ message: "Unrecognized field parent" }] }, 400)
        : new Response(null, { status: 204 }),
    );
    await client().setBuildStatus("a".repeat(40), STATUS);
    expect(server.requests.map((r) => r.body)).toEqual([
      { ...BASE_BODY, parent: "droid-review", ref: "refs/heads/feature/x" },
      BASE_BODY,
    ]);
  });

  it("does not retry build statuses on other errors", async () => {
    server = startFakeServer(() =>
      json({ errors: [{ message: "Commit not found" }] }, 404),
    );
    await expect(
      client().setBuildStatus("a".repeat(40), STATUS),
    ).rejects.toThrow("Commit not found");
    expect(server.requests).toHaveLength(1);
  });

  it("joins Data Center error messages", async () => {
    server = startFakeServer(() =>
      json(
        {
          errors: [
            {
              context: null,
              message: "Repository PROJ/my-repo does not exist.",
              exceptionName: "NoSuchRepositoryException",
            },
          ],
        },
        404,
      ),
    );
    await expect(client().getPullRequest()).rejects.toThrow(
      "Bitbucket API 404: Not Found (GET " +
        `${server.url}${PR}) - Repository PROJ/my-repo does not exist.`,
    );
  });
});
