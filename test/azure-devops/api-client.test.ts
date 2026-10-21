import { describe, expect, it } from "bun:test";
import {
  AzureDevopsApiError,
  AzureDevopsClient,
} from "../../src/azure-devops/api/client";
import type { AdoCreateThreadRequest } from "../../src/azure-devops/types";
import { createFakeAdo, json } from "./helpers";

const SERVICES = "https://dev.azure.com/contoso/";
const SERVER = "https://ado.contoso.local/tfs/DefaultCollection";

function client(fake: ReturnType<typeof createFakeAdo>, overrides = {}) {
  return new AzureDevopsClient({
    collectionUri: SERVICES,
    project: "Fabrikam Web",
    repositoryId: "repo-guid",
    auth: { kind: "bearer", token: "job-token-value-1234" },
    fetch: fake.fetch,
    sleep: async () => {},
    ...overrides,
  });
}

describe("AzureDevopsClient URLs", () => {
  it("builds Services URLs with an encoded project and the pinned api-version", async () => {
    const fake = createFakeAdo();
    fake.on("GET", "/pullRequests/17", () =>
      json({ pullRequestId: 17, status: "active" }),
    );
    await client(fake).getPullRequest(17);
    expect(fake.requests[0]!.url).toBe(
      "https://dev.azure.com/contoso/Fabrikam%20Web/_apis/git/repositories/repo-guid/pullRequests/17?api-version=6.0",
    );
  });

  it("builds Server URLs under the collection path", async () => {
    const fake = createFakeAdo();
    fake.on("GET", "/pullRequests/3", () =>
      json({ pullRequestId: 3, status: "active" }),
    );
    await client(fake, {
      collectionUri: `${SERVER}/`,
      project: "Platform",
    }).getPullRequest(3);
    expect(fake.requests[0]!.url).toBe(
      "https://ado.contoso.local/tfs/DefaultCollection/Platform/_apis/git/repositories/repo-guid/pullRequests/3?api-version=6.0",
    );
  });

  it("honors an api-version override", async () => {
    const fake = createFakeAdo();
    fake.on("GET", "/pullRequests/1", () => json({ pullRequestId: 1 }));
    await client(fake, { apiVersion: "7.1" }).getPullRequest(1);
    expect(new URL(fake.requests[0]!.url).searchParams.get("api-version")).toBe(
      "7.1",
    );
  });
});

describe("AzureDevopsClient auth headers", () => {
  it("sends the job token as a Bearer token", async () => {
    const fake = createFakeAdo();
    fake.on("GET", "/pullRequests/1", () => json({ pullRequestId: 1 }));
    await client(fake).getPullRequest(1);
    expect(fake.requests[0]!.headers.Authorization).toBe(
      "Bearer job-token-value-1234",
    );
  });

  it("sends a PAT as Basic auth with an empty user name", async () => {
    const fake = createFakeAdo();
    fake.on("GET", "/pullRequests/1", () => json({ pullRequestId: 1 }));
    await client(fake, {
      auth: { kind: "pat", token: "my-pat" },
    }).getPullRequest(1);
    expect(fake.requests[0]!.headers.Authorization).toBe(
      `Basic ${Buffer.from(":my-pat").toString("base64")}`,
    );
  });
});

describe("AzureDevopsClient writes", () => {
  it("POSTs a thread as JSON", async () => {
    const fake = createFakeAdo();
    fake.on("POST", "/pullRequests/17/threads", (req) =>
      json({
        id: 90,
        comments: [{ id: 1, content: "x" }],
        ...(req.body as object),
      }),
    );
    const thread = await client(fake).createThread(17, {
      comments: [{ parentCommentId: 0, content: "hello", commentType: "text" }],
      status: "active",
    });
    const req = fake.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers["Content-Type"]).toBe("application/json");
    expect(req.body).toEqual({
      comments: [{ parentCommentId: 0, content: "hello", commentType: "text" }],
      status: "active",
    });
    expect(thread.id).toBe(90);
  });

  it("PATCHes a comment's content", async () => {
    const fake = createFakeAdo();
    fake.on("PATCH", "/pullRequests/17/threads/90/comments/1", () =>
      json({ id: 1, content: "new" }),
    );
    await client(fake).updateComment(17, 90, 1, "new");
    expect(fake.requests[0]!.method).toBe("PATCH");
    expect(fake.requests[0]!.body).toEqual({ content: "new" });
  });
});

describe("AzureDevopsClient pagination", () => {
  it("follows x-ms-continuationtoken across thread pages", async () => {
    const fake = createFakeAdo();
    fake.on("GET", "/pullRequests/17/threads", (_req, url) => {
      if (url.searchParams.get("continuationToken") === "page2") {
        return json({ value: [{ id: 2, comments: [] }], count: 1 });
      }
      return json({ value: [{ id: 1, comments: [] }], count: 1 }, 200, {
        "x-ms-continuationtoken": "page2",
      });
    });
    const threads = await client(fake).listThreads(17);
    expect(threads.map((t) => t.id)).toEqual([1, 2]);
    expect(fake.requests).toHaveLength(2);
    expect(
      new URL(fake.requests[0]!.url).searchParams.has("continuationToken"),
    ).toBe(false);
    expect(
      new URL(fake.requests[1]!.url).searchParams.get("continuationToken"),
    ).toBe("page2");
  });

  it("pages iteration changes with $top/$skip until nextSkip is absent", async () => {
    const fake = createFakeAdo();
    fake.on("GET", "/pullRequests/17/iterations/3/changes", (_req, url) => {
      const skip = url.searchParams.get("$skip");
      if (skip === "0") {
        return json({
          changeEntries: [
            { changeTrackingId: 1, item: { path: "/a.ts" } },
            { changeTrackingId: 2, item: { path: "/b.ts" } },
          ],
          nextSkip: 2,
          nextTop: 2,
        });
      }
      return json({
        changeEntries: [{ changeTrackingId: 3, item: { path: "/c.ts" } }],
      });
    });
    const changes = await client(fake).listIterationChanges(17, 3);
    expect(changes.map((c) => c.item.path)).toEqual([
      "/a.ts",
      "/b.ts",
      "/c.ts",
    ]);
    const second = new URL(fake.requests[1]!.url).searchParams;
    expect(second.get("$skip")).toBe("2");
    expect(second.get("$top")).toBe("2");
  });
});

describe("AzureDevopsClient retries", () => {
  function flaky(method: string, suffix: string, failures: Response[]) {
    const fake = createFakeAdo();
    let calls = 0;
    fake.on(method, suffix, () =>
      calls < failures.length ? failures[calls++]! : json({ id: 1 }),
    );
    return fake;
  }

  it("retries a throttled GET after the Retry-After delay", async () => {
    const fake = flaky("GET", "/pullRequests/1", [
      json({ message: "slow down" }, 429, { "Retry-After": "2" }),
      new Response("bad gateway", { status: 502 }),
    ]);
    const delays: number[] = [];
    const pr = await client(fake, {
      sleep: async (ms: number) => void delays.push(ms),
      retryDelayMs: 100,
    }).getPullRequest(1);
    expect(pr).toEqual({ id: 1 } as never);
    expect(fake.requests).toHaveLength(3);
    // Retry-After wins on the first retry; backoff doubles on the second.
    expect(delays).toEqual([2000, 200]);
  });

  it("gives up after maxRetries and surfaces the last error", async () => {
    const fake = createFakeAdo();
    fake.on(
      "GET",
      "/pullRequests/1",
      () => new Response("down", { status: 503 }),
    );
    const error = await client(fake, { maxRetries: 2 })
      .getPullRequest(1)
      .catch((e) => e);
    expect(error).toBeInstanceOf(AzureDevopsApiError);
    expect(error.status).toBe(503);
    expect(fake.requests).toHaveLength(3);
  });

  const thread: AdoCreateThreadRequest = {
    comments: [{ parentCommentId: 0, content: "x", commentType: "text" }],
  };

  it("retries a POST that was throttled", async () => {
    const fake = flaky("POST", "/threads", [json({}, 429)]);
    await client(fake).createThread(1, thread);
    expect(fake.requests).toHaveLength(2);
  });

  it("does not retry a POST on 5xx, which may already have created the thread", async () => {
    const fake = flaky("POST", "/threads", [json({}, 503)]);
    const error = await client(fake)
      .createThread(1, thread)
      .catch((e) => e);
    expect(error.status).toBe(503);
    expect(fake.requests).toHaveLength(1);
  });
});

describe("AzureDevopsClient credential handling", () => {
  it("redacts the token from thread bodies before sending them", async () => {
    const fake = createFakeAdo();
    fake.on("POST", "/threads", () => json({ id: 1 }));
    await client(fake).createThread(1, {
      comments: [
        {
          parentCommentId: 0,
          content: "The build printed job-token-value-1234 in its log",
          commentType: "text",
        },
      ],
    });
    expect(fake.requests[0]!.body).toEqual({
      comments: [
        {
          parentCommentId: 0,
          content: "The build printed [REDACTED] in its log",
          commentType: "text",
        },
      ],
    });
  });

  it("redacts credentials echoed in error bodies", async () => {
    const fake = createFakeAdo();
    fake.on("GET", "/pullRequests/1", () =>
      json({ message: "bad header Bearer job-token-value-1234" }, 400),
    );
    const error = await client(fake)
      .getPullRequest(1)
      .catch((e) => e);
    expect(error.message).toContain("bad header Bearer [REDACTED]");
    expect(JSON.stringify(error.body)).not.toContain("job-token-value-1234");
  });

  it("refuses to follow redirects, which would carry the Authorization header", async () => {
    const fake = createFakeAdo();
    fake.on("GET", "/pullRequests/1", () => json({ pullRequestId: 1 }));
    const seen: RequestInit[] = [];
    await client(fake, {
      fetch: (url: string, init: RequestInit) => {
        seen.push(init);
        return fake.fetch(url, init);
      },
    }).getPullRequest(1);
    expect(seen[0]!.redirect).toBe("error");
  });
});

describe("AzureDevopsClient errors", () => {
  it("surfaces the Azure DevOps error message and status", async () => {
    const fake = createFakeAdo();
    fake.on("POST", "/threads", () =>
      json(
        {
          $id: "1",
          innerException: null,
          message:
            "TF401027: You need the Git 'PullRequestContribute' permission to perform this action.",
          typeName:
            "Microsoft.TeamFoundation.Git.Server.GitNeedsPermissionException",
          errorCode: 0,
        },
        403,
      ),
    );
    const error = await client(fake)
      .createThread(1, {
        comments: [{ parentCommentId: 0, content: "x", commentType: "text" }],
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(AzureDevopsApiError);
    expect(error.status).toBe(403);
    expect(error.message).toContain("Azure DevOps API 403 on POST");
    expect(error.message).toContain("TF401027");
    expect(error.message).not.toContain("job-token");
  });

  it("treats a 203 HTML sign-in page as an auth failure", async () => {
    const fake = createFakeAdo();
    fake.on(
      "GET",
      "/pullRequests/1",
      () =>
        new Response("<html><title>Azure DevOps Services | Sign In</title>", {
          status: 203,
          headers: { "Content-Type": "text/html" },
        }),
    );
    const error = await client(fake, {
      auth: { kind: "pat", token: "expired-pat" },
    })
      .getPullRequest(1)
      .catch((e) => e);
    expect(error).toBeInstanceOf(AzureDevopsApiError);
    expect(error.status).toBe(203);
    expect(error.message).toContain("invalid or expired token");
    expect(error.message).not.toContain("expired-pat");
  });

  it("keeps non-JSON error bodies", async () => {
    const fake = createFakeAdo();
    fake.on(
      "GET",
      "/pullRequests/1",
      () => new Response("Service Unavailable", { status: 503 }),
    );
    const error = await client(fake)
      .getPullRequest(1)
      .catch((e) => e);
    expect(error.status).toBe(503);
    expect(error.message).toContain("Service Unavailable");
  });
});
