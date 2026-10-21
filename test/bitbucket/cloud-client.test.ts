import { afterEach, describe, expect, it } from "bun:test";
import { BitbucketCloudClient } from "../../src/bitbucket/api/cloud";
import {
  BitbucketApiError,
  mayForwardCredentials,
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

const BEARER = { header: "Bearer cloud-secret" };
const PR_PATH = "/2.0/repositories/my-ws/my-repo/pullrequests/7";

let server: FakeServer;
let other: FakeServer | undefined;
afterEach(() => {
  server?.stop();
  other?.stop();
  other = undefined;
});

const FULL_HEAD = "abcdef123456" + "7".repeat(28);
const COMMIT_PATH = "/2.0/repositories/my-ws/my-repo/commit/abcdef123456";

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
    server = startFakeServer((req) => {
      if (req.path === PR_PATH) return json(CLOUD_PR);
      if (req.path === COMMIT_PATH) return json({ hash: FULL_HEAD });
      return notFound();
    });

    const pr = await client().getPullRequest();

    expect(server.requests.map((r) => r.path)).toEqual([PR_PATH, COMMIT_PATH]);
    expect(server.requests[1]!.headers.authorization).toBe(
      "Bearer cloud-secret",
    );
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
      sourceBranch: "feature/c",
      targetBranch: "main",
      // The PR payload only carries the 12-character abbreviation.
      headSha: FULL_HEAD,
      baseSha: "0123456789ab",
      webUrl: "https://bitbucket.org/my-ws/my-repo/pull-requests/7",
    });
  });

  it("keeps the abbreviated head when the commit lookup fails", async () => {
    server = startFakeServer((req) =>
      req.path === PR_PATH ? json(CLOUD_PR) : notFound(),
    );
    const pr = await client().getPullRequest();
    expect(pr.headSha).toBe("abcdef123456");
  });

  it("sends HTTP Basic auth for an API token", async () => {
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

    expect(diff).toEqual({ text: APP_TS_DIFF, truncated: false });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]!.headers.authorization).toBe(
      "Bearer cloud-secret",
    );
  });

  it("keeps the credentials on a diff redirect to another origin of the same host", async () => {
    // fetch strips Authorization on any cross-origin redirect; a different
    // port is enough to make it cross-origin.
    other = startFakeServer(
      () =>
        new Response(APP_TS_DIFF, {
          headers: { "Content-Type": "text/plain" },
        }),
    );
    server = startFakeServer(
      () =>
        new Response(null, {
          status: 302,
          headers: {
            Location: `${other!.url}/2.0/repositories/my-ws/my-repo/diff/x`,
          },
        }),
    );

    const diff = await client().getDiff();

    expect(diff.text).toBe(APP_TS_DIFF);
    expect(other.requests).toHaveLength(1);
    expect(other.requests[0]!.headers.authorization).toBe(
      "Bearer cloud-secret",
    );
    expect(other.requests[0]!.headers.accept).toBe("text/plain");
  });

  it("never forwards the credentials to a redirect on a foreign host", async () => {
    other = startFakeServer(() => new Response(APP_TS_DIFF));
    server = startFakeServer(
      () =>
        new Response(null, {
          status: 302,
          headers: {
            Location: `${other!.url.replace("localhost", "127.0.0.1")}/diff`,
          },
        }),
    );

    await client().getDiff();

    expect(other.requests).toHaveLength(1);
    expect(other.requests[0]!.headers.authorization).toBeUndefined();
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
              user: { nickname: "bob", uuid: "{b0b}" },
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
      authorId: "{b0b}",
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
      startLine: 2,
    });
    await c.createInlineComment("removed", {
      path: "src/app.ts",
      oldPath: null,
      line: 2,
      lineType: "REMOVED",
      startLine: null,
    });
    await c.createInlineComment("context", {
      path: "src/app.ts",
      oldPath: null,
      line: 4,
      lineType: "CONTEXT",
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
      ref: "refs/heads/feature/x",
    });
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/2.0/repositories/my-ws/my-repo/commit/abc123/statuses/build",
    });
    // Cloud has no parent/ref fields; the Data Center-only ref stays off.
    expect(server.requests[0]!.body).toEqual({
      key: "droid-review",
      state: "INPROGRESS",
      name: "Droid code review",
      url: "https://ci/1",
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

  it("redacts the job's credentials from every request body and error", async () => {
    const saved = process.env.DROID_BITBUCKET_TOKEN;
    process.env.DROID_BITBUCKET_TOKEN = "cloud-secret-token";
    try {
      server = startFakeServer((req) =>
        json(
          {
            type: "error",
            error: {
              message: `rejected ${JSON.stringify(req.body)} cloud-secret-token`,
            },
          },
          400,
        ),
      );
      const error = await client()
        .createComment("model quoted cloud-secret-token from a tool")
        .catch((e) => e);

      expect(server.requests[0]!.body.content.raw).toBe(
        "model quoted [REDACTED] from a tool",
      );
      expect(error).toBeInstanceOf(BitbucketApiError);
      expect(error.message).not.toContain("cloud-secret-token");
      expect(JSON.stringify(error.body)).not.toContain("cloud-secret-token");
    } finally {
      if (saved === undefined) delete process.env.DROID_BITBUCKET_TOKEN;
      else process.env.DROID_BITBUCKET_TOKEN = saved;
    }
  });

  it("redacts the Basic-encoded API token from request bodies and errors", async () => {
    const saved = {
      user: process.env.DROID_BITBUCKET_USERNAME,
      token: process.env.DROID_BITBUCKET_API_TOKEN,
    };
    process.env.DROID_BITBUCKET_USERNAME = "ada@example.com";
    process.env.DROID_BITBUCKET_API_TOKEN = "bb-api-secret";
    const encoded = Buffer.from("ada@example.com:bb-api-secret").toString(
      "base64",
    );
    try {
      server = startFakeServer(() =>
        json(
          { type: "error", error: { message: `echo Basic ${encoded}` } },
          400,
        ),
      );
      const error = await client()
        .createComment(`curl -H 'Authorization: Basic ${encoded}'`)
        .catch((e) => e);

      expect(server.requests[0]!.body.content.raw).toBe(
        "curl -H 'Authorization: Basic [REDACTED]'",
      );
      expect(error).toBeInstanceOf(BitbucketApiError);
      expect(error.message).toContain("echo Basic [REDACTED]");
      expect(JSON.stringify(error.body)).not.toContain(encoded);
    } finally {
      for (const [name, value] of [
        ["DROID_BITBUCKET_USERNAME", saved.user],
        ["DROID_BITBUCKET_API_TOKEN", saved.token],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("retries rate-limited and transient responses, then gives up", async () => {
    let calls = 0;
    server = startFakeServer(() => {
      calls += 1;
      return calls < 3 ? json({}, calls === 1 ? 429 : 503) : json(CLOUD_PR);
    });
    const pr = await client().getPullRequest();
    expect(pr.id).toBe(7);
    expect(server.requests.filter((r) => r.path === PR_PATH)).toHaveLength(3);

    server.stop();
    server = startFakeServer(() => json({}, 503));
    await expect(client().getPullRequest()).rejects.toThrow(
      /Bitbucket API 503/,
    );
    // One try plus three retries.
    expect(server.requests).toHaveLength(4);
  });

  it.each([502, 504])(
    "does not repeat a POST after a %i the server may have committed",
    async (status) => {
      server = startFakeServer(() => json({}, status));
      await expect(client().createComment("x")).rejects.toThrow(
        new RegExp(`Bitbucket API ${status}`),
      );
      expect(server.requests).toHaveLength(1);
    },
  );

  it("does not repeat a POST after a 503 without Retry-After", async () => {
    server = startFakeServer(() => json({}, 503));
    await expect(
      client().setBuildStatus("a".repeat(40), {
        key: "droid-review",
        state: "INPROGRESS",
        name: "Droid code review",
        url: "https://ci/1",
      }),
    ).rejects.toThrow(/Bitbucket API 503/);
    expect(server.requests).toHaveLength(1);
  });

  it("retries a POST the server explicitly refused (429, or 503 with Retry-After)", async () => {
    let calls = 0;
    server = startFakeServer((req) => {
      calls += 1;
      if (calls === 1) return json({}, 429);
      if (calls === 2) return json({}, 503, { "Retry-After": "1" });
      return json({ id: 9, content: { raw: req.body.content.raw } }, 201);
    });
    const created = await client().createComment("x");
    expect(created.id).toBe(9);
    expect(server.requests.map((r) => r.method)).toEqual([
      "POST",
      "POST",
      "POST",
    ]);
  });

  it("retries an idempotent PUT on a gateway timeout", async () => {
    let calls = 0;
    server = startFakeServer(() => {
      calls += 1;
      return calls === 1
        ? json({}, 504)
        : json({ id: 5, content: { raw: "u" } });
    });
    await client().updateComment(5, "u");
    expect(server.requests).toHaveLength(2);
  });

  it("does not retry client errors", async () => {
    server = startFakeServer(() =>
      json({ type: "error", error: { message: "nope" } }, 404),
    );
    await expect(client().getPullRequest()).rejects.toThrow(/404/);
    expect(server.requests).toHaveLength(1);
  });
});

describe("mayForwardCredentials", () => {
  const u = (s: string) => new URL(s);
  it("allows the same host and moves between Bitbucket Cloud hosts", () => {
    expect(
      mayForwardCredentials(
        u("https://api.bitbucket.org/2.0/x"),
        u("https://api.bitbucket.org/2.0/y"),
      ),
    ).toBe(true);
    expect(
      mayForwardCredentials(
        u("https://api.bitbucket.org/2.0/x"),
        u("https://bitbucket.org/ws/repo/diff"),
      ),
    ).toBe(true);
  });

  it("refuses other hosts, look-alikes, and https downgrades", () => {
    expect(
      mayForwardCredentials(
        u("https://api.bitbucket.org/2.0/x"),
        u("https://bbuseruploads.s3.amazonaws.com/x"),
      ),
    ).toBe(false);
    expect(
      mayForwardCredentials(
        u("https://api.bitbucket.org/2.0/x"),
        u("https://bitbucket.org.evil.example/x"),
      ),
    ).toBe(false);
    expect(
      mayForwardCredentials(
        u("https://api.bitbucket.org/2.0/x"),
        u("http://api.bitbucket.org/2.0/x"),
      ),
    ).toBe(false);
  });
});
