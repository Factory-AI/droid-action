import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { GitlabClient, GitlabApiError } from "../../src/gitlab/api/client";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  const fn = mock(async (url: string, init: RequestInit) => impl(url, init));
  // @ts-expect-error overriding global fetch in tests
  globalThis.fetch = fn;
  return fn;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitlabClient", () => {
  beforeEach(() => {
    // each test installs its own fetch mock
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("sends PRIVATE-TOKEN header on GET", async () => {
    const fetchMock = mockFetch((url, init) => {
      expect(url).toBe(
        "https://gitlab.com/api/v4/projects/42/merge_requests/7",
      );
      expect(init.method ?? "GET").toBe("GET");
      const headers = init.headers as Record<string, string>;
      expect(headers["PRIVATE-TOKEN"]).toBe("glpat-test");
      return jsonResponse({ iid: 7 });
    });

    const client = new GitlabClient("glpat-test");
    const mr = await client.getMr(42, 7);
    expect(mr).toEqual({ iid: 7 } as never);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends JSON body on POST createNote", async () => {
    mockFetch((url, init) => {
      expect(url).toBe(
        "https://gitlab.com/api/v4/projects/42/merge_requests/7/notes",
      );
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ body: "hello" }));
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      return jsonResponse({ id: 1, body: "hello" });
    });

    const client = new GitlabClient("glpat-test");
    const note = await client.createNote(42, 7, "hello");
    expect((note as { id: number }).id).toBe(1);
  });

  it("URL-encodes string project ids (path-with-namespace)", async () => {
    mockFetch((url) => {
      expect(url).toBe(
        "https://gitlab.com/api/v4/projects/group%2Fsub%2Frepo/merge_requests/7",
      );
      return jsonResponse({ iid: 7 });
    });
    const client = new GitlabClient("glpat-test");
    await client.getMr("group/sub/repo", 7);
  });

  it("respects a custom baseUrl (self-hosted)", async () => {
    mockFetch((url) => {
      expect(url).toBe(
        "https://gitlab.example.com/api/v4/projects/1/merge_requests/2",
      );
      return jsonResponse({ iid: 2 });
    });
    const client = new GitlabClient(
      "glpat-test",
      "https://gitlab.example.com/api/v4",
    );
    await client.getMr(1, 2);
  });

  it("throws GitlabApiError with parsed body on non-2xx", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ message: "404 Not Found" }), {
          status: 404,
          statusText: "Not Found",
          headers: { "Content-Type": "application/json" },
        }),
    );

    const client = new GitlabClient("glpat-test");
    try {
      await client.getMr(42, 999);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GitlabApiError);
      const e = err as GitlabApiError;
      expect(e.status).toBe(404);
      expect((e.body as { message: string }).message).toBe("404 Not Found");
      // The body detail is the actionable part (e.g. which position field
      // GitLab refused), so it must survive into the message CI logs show.
      expect(e.message).toContain('"message":"404 Not Found"');
    }
  });

  describe("credential handling", () => {
    const FACTORY_KEY = "fk-" + "a".repeat(40);
    const CLIENT_TOKEN = "client-token-value-1234567890";
    let savedKey: string | undefined;

    beforeEach(() => {
      savedKey = process.env.FACTORY_API_KEY;
      process.env.FACTORY_API_KEY = "factory-env-secret-1234567890";
    });

    afterEach(() => {
      if (savedKey === undefined) delete process.env.FACTORY_API_KEY;
      else process.env.FACTORY_API_KEY = savedKey;
    });

    it("redacts credentials from every body it writes", async () => {
      const bodies: string[] = [];
      mockFetch((_url, init) => {
        bodies.push(String(init.body));
        return jsonResponse({ id: 1 });
      });
      const leak = `token ${CLIENT_TOKEN} env factory-env-secret-1234567890 key ${FACTORY_KEY}`;
      const client = new GitlabClient(CLIENT_TOKEN);

      await client.createNote(1, 2, leak);
      await client.updateNote(1, 2, 3, leak);
      await client.createDiscussionOnDiff(1, 2, leak, {
        base_sha: "a",
        start_sha: "b",
        head_sha: "c",
        position_type: "text",
        new_path: "x.ts",
        new_line: 1,
      });
      await client.updateMrDescription(1, 2, leak);

      expect(bodies).toHaveLength(4);
      for (const body of bodies) {
        expect(body).not.toContain(CLIENT_TOKEN);
        expect(body).not.toContain("factory-env-secret-1234567890");
        expect(body).not.toContain(FACTORY_KEY);
        expect(body).toContain("[REDACTED]");
      }
    });

    it("redacts credentials echoed in an error response", async () => {
      mockFetch(
        () =>
          new Response(
            JSON.stringify({ message: `bad token ${CLIENT_TOKEN}` }),
            { status: 401, statusText: "Unauthorized" },
          ),
      );
      const client = new GitlabClient(CLIENT_TOKEN);
      const err = await client.getMr(1, 2).catch((e) => e);
      expect(err).toBeInstanceOf(GitlabApiError);
      expect(err.message).not.toContain(CLIENT_TOKEN);
      expect(JSON.stringify(err.body)).not.toContain(CLIENT_TOKEN);
      expect(err.message).toContain("[REDACTED]");
    });

    it("refuses redirects so PRIVATE-TOKEN never follows one", async () => {
      const fetchMock = mockFetch(() => jsonResponse({ iid: 2 }));
      await new GitlabClient(CLIENT_TOKEN).getMr(1, 2);
      expect(fetchMock.mock.calls[0]![1].redirect).toBe("error");
    });
  });

  describe("request paths", () => {
    const request = (client: GitlabClient, path: string) =>
      (
        client as unknown as {
          request: (path: string) => Promise<unknown>;
        }
      ).request(path);

    for (const path of [
      "https://evil.example.com/api/v4/user",
      "http://gitlab.com/api/v4/user",
      "https://gitlab.com/api/v4/user",
      "//evil.example.com/user",
      "user",
    ]) {
      it(`refuses ${path} without sending the token anywhere`, async () => {
        const fetchMock = mockFetch(() => jsonResponse({}));
        await expect(
          request(new GitlabClient("glpat-test"), path),
        ).rejects.toThrow(/relative to its API base URL/);
        expect(fetchMock).toHaveBeenCalledTimes(0);
      });
    }
  });
});
