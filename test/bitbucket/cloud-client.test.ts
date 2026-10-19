import { afterEach, describe, expect, it } from "bun:test";
import { BitbucketCloudClient } from "../../src/bitbucket/api/cloud";
import {
  BitbucketApiError,
  type BitbucketAuth,
} from "../../src/bitbucket/api/http";
import { resolveBitbucketAuth } from "../../src/bitbucket/token";
import {
  APP_TS_DIFF,
  json,
  notFound,
  startFakeServer,
  type FakeServer,
} from "./fake-server";

const BEARER = { scheme: "bearer" as const, header: "Bearer cloud-secret" };
const PR_PATH = "/2.0/repositories/my-ws/my-repo/pullrequests/7";

let server: FakeServer;
afterEach(() => server?.stop());

function client(auth: BitbucketAuth = BEARER) {
  return new BitbucketCloudClient({
    auth,
    workspace: "my-ws",
    repoSlug: "my-repo",
    prId: 7,
    apiUrl: `${server.url}/2.0/`,
    retryDelayMs: 0,
  });
}

const CLOUD_PR = {
  type: "pullrequest",
  id: 7,
  title: "Add c",
  description: "Adds const c",
  state: "OPEN",
  draft: true,
  author: { display_name: "Ada Lovelace", nickname: "ada" },
  source: {
    branch: { name: "feature/c" },
    commit: { hash: "abcdef123456", type: "commit" },
  },
  destination: {
    branch: { name: "main" },
    commit: { hash: "0123456789ab", type: "commit" },
  },
  links: {
    html: { href: "https://bitbucket.org/my-ws/my-repo/pull-requests/7" },
  },
};

describe("BitbucketCloudClient", () => {
  it("fetches and normalizes a pull request with a Bearer token", async () => {
    server = startFakeServer((req) =>
      req.path === PR_PATH ? json(CLOUD_PR) : notFound(),
    );

    const pr = await client().getPullRequest();

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.method).toBe("GET");
    expect(server.requests[0]!.headers.authorization).toBe(
      "Bearer cloud-secret",
    );
    expect(server.requests[0]!.headers.accept).toBe("application/json");
    expect(pr).toEqual({
      id: 7,
      title: "Add c",
      description: "Adds const c",
      draft: true,
      state: "OPEN",
      sourceBranch: "feature/c",
      targetBranch: "main",
      headSha: "abcdef123456",
      authorName: "ada",
      webUrl: "https://bitbucket.org/my-ws/my-repo/pull-requests/7",
    });
  });

  it("sends HTTP Basic auth for an API token or app password", async () => {
    server = startFakeServer(() => json(CLOUD_PR));
    const auth = resolveBitbucketAuth({
      DROID_BITBUCKET_USERNAME: "dev@example.com",
      DROID_BITBUCKET_API_TOKEN: "ATATT-token",
    });

    await client(auth).getPullRequest();

    expect(server.requests[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from("dev@example.com:ATATT-token").toString("base64")}`,
    );
  });

  it("URL-encodes workspace and repository slugs", async () => {
    server = startFakeServer(() => json(CLOUD_PR));
    await new BitbucketCloudClient({
      auth: BEARER,
      workspace: "{ws uuid}",
      repoSlug: "repo name",
      prId: 3,
      apiUrl: server.url,
    }).getPullRequest();
    expect(server.requests[0]!.path).toBe(
      "/repositories/%7Bws%20uuid%7D/repo%20name/pullrequests/3",
    );
  });

  it("follows the diff redirect and keeps the credentials", async () => {
    server = startFakeServer((req) => {
      if (req.path === `${PR_PATH}/diff`) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${server.url}/2.0/repositories/my-ws/my-repo/diff/my-ws/my-repo:abcdef123456%0D0123456789ab?from_pullrequest_id=7`,
          },
        });
      }
      if (req.path.startsWith("/2.0/repositories/my-ws/my-repo/diff/")) {
        return new Response(APP_TS_DIFF, {
          headers: { "Content-Type": "text/plain" },
        });
      }
      return notFound();
    });

    const diff = await client().getDiff();

    expect(diff).toBe(APP_TS_DIFF);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.headers.authorization).toBe(
      "Bearer cloud-secret",
    );
  });

  it("follows `next` links across comment pages and drops deleted comments", async () => {
    server = startFakeServer((_req, url) => {
      if (url.pathname !== `${PR_PATH}/comments`) return notFound();
      if (url.searchParams.get("page") === "2") {
        return json({
          pagelen: 100,
          page: 2,
          values: [
            {
              id: 3,
              content: { raw: "inline note" },
              user: { nickname: "bob" },
              inline: { path: "src/app.ts", from: null, to: 3 },
              parent: { id: 1 },
              created_on: "2026-01-02T00:00:00Z",
            },
          ],
        });
      }
      return json({
        pagelen: 100,
        page: 1,
        values: [
          { id: 1, content: { raw: "first" }, user: { nickname: "ada" } },
          { id: 2, content: { raw: "gone" }, deleted: true },
        ],
        next: `${server.url}${PR_PATH}/comments?pagelen=100&page=2`,
      });
    });

    const comments = await client().listComments();

    expect(server.requests.map((r) => r.path)).toEqual([
      `${PR_PATH}/comments?pagelen=100`,
      `${PR_PATH}/comments?pagelen=100&page=2`,
    ]);
    expect(comments.map((c) => c.id)).toEqual([1, 3]);
    expect(comments[1]).toEqual({
      id: 3,
      body: "inline note",
      author: "bob",
      createdAt: "2026-01-02T00:00:00Z",
      path: "src/app.ts",
      line: 3,
      parentId: 1,
    });
  });

  it("creates and updates top-level comments with content.raw", async () => {
    server = startFakeServer((req) =>
      json(
        { id: 55, content: { raw: req.body.content.raw } },
        req.method === "POST" ? 201 : 200,
      ),
    );

    const created = await client().createComment("hello");
    await client().updateComment(55, "updated");

    expect(created.id).toBe(55);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: `${PR_PATH}/comments`,
      body: { content: { raw: "hello" } },
    });
    expect(server.requests[0]!.headers["content-type"]).toBe(
      "application/json",
    );
    expect(server.requests[1]).toMatchObject({
      method: "PUT",
      path: `${PR_PATH}/comments/55`,
      body: { content: { raw: "updated" } },
    });
  });

  it("anchors inline comments with `to`, `from` and range starts", async () => {
    server = startFakeServer(() => json({ id: 1, content: { raw: "x" } }, 201));
    const c = client();

    await c.createInlineComment("added", {
      path: "src/app.ts",
      oldPath: null,
      line: 3,
      lineType: "ADDED",
      oldLine: null,
      startLine: 2,
    });
    await c.createInlineComment("removed", {
      path: "src/app.ts",
      oldPath: null,
      line: 2,
      lineType: "REMOVED",
      oldLine: 2,
      startLine: null,
    });
    await c.createInlineComment("context", {
      path: "src/app.ts",
      oldPath: null,
      line: 4,
      lineType: "CONTEXT",
      oldLine: 3,
      startLine: null,
    });

    expect(server.requests.map((r) => r.body)).toEqual([
      {
        content: { raw: "added" },
        inline: { path: "src/app.ts", to: 3, start_to: 2 },
      },
      { content: { raw: "removed" }, inline: { path: "src/app.ts", from: 2 } },
      { content: { raw: "context" }, inline: { path: "src/app.ts", to: 4 } },
    ]);
  });

  it("posts commit build statuses", async () => {
    server = startFakeServer(() => json({ key: "droid-review" }, 201));
    await client().setBuildStatus("abc123", {
      key: "droid-review",
      state: "INPROGRESS",
      name: "Droid code review",
      url: "https://ci/1",
    });
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/2.0/repositories/my-ws/my-repo/commit/abc123/statuses/build",
      body: {
        key: "droid-review",
        state: "INPROGRESS",
        name: "Droid code review",
        url: "https://ci/1",
      },
    });
  });

  it("surfaces Cloud error messages without leaking the token", async () => {
    server = startFakeServer(() =>
      json(
        {
          type: "error",
          error: {
            message: "Access denied",
            detail: "Token is missing the pullrequest:write scope",
          },
        },
        403,
      ),
    );

    const error = await client()
      .createComment("x")
      .catch((e) => e);

    expect(error).toBeInstanceOf(BitbucketApiError);
    expect(error.status).toBe(403);
    expect(error.message).toContain("Bitbucket API 403");
    expect(error.message).toContain(
      "Access denied (Token is missing the pullrequest:write scope)",
    );
    expect(error.message).toContain(`POST ${server.url}${PR_PATH}/comments`);
    expect(error.message).not.toContain("cloud-secret");
  });

  it("retries rate-limited and transient responses, then gives up", async () => {
    let calls = 0;
    server = startFakeServer(() => {
      calls += 1;
      return calls < 3 ? json({}, calls === 1 ? 429 : 503) : json(CLOUD_PR);
    });
    const pr = await client().getPullRequest();
    expect(pr.id).toBe(7);
    expect(server.requests).toHaveLength(3);

    server.stop();
    server = startFakeServer(() => json({}, 503));
    await expect(client().getPullRequest()).rejects.toThrow(
      /Bitbucket API 503/,
    );
    // One try plus three retries.
    expect(server.requests).toHaveLength(4);
  });

  it("does not retry client errors", async () => {
    server = startFakeServer(() =>
      json({ type: "error", error: { message: "nope" } }, 404),
    );
    await expect(client().getPullRequest()).rejects.toThrow(/404/);
    expect(server.requests).toHaveLength(1);
  });
});
