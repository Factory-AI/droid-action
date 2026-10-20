import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import {
  createOctokit,
  withRequestRedaction,
} from "../../../src/github/api/client";

const TOKEN = `ghs_${"B".repeat(36)}`;
// Matches no token format, so only exact-value redaction can catch it.
const FACTORY_KEY = "factory-key-value-abcdefghijklmnop";
const OTHER_PAT = `ghp_${"C".repeat(36)}`;
const LEAKY_TEXT = `token ${TOKEN} key ${FACTORY_KEY} pat ${OTHER_PAT}`;

type CapturedRequest = {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
};

describe("GitHub client request redaction", () => {
  let requests: CapturedRequest[];
  let fetchSpy: ReturnType<typeof spyOn>;
  const originalKey = process.env.FACTORY_API_KEY;

  beforeEach(() => {
    requests = [];
    process.env.FACTORY_API_KEY = FACTORY_KEY;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
      input: unknown,
      init?: RequestInit,
    ) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
        headers: Object.fromEntries(
          new Headers(
            init?.headers as ConstructorParameters<typeof Headers>[0],
          ).entries(),
        ),
      });
      return new Response(JSON.stringify({ id: 1, data: { ok: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (originalKey === undefined) delete process.env.FACTORY_API_KEY;
    else process.env.FACTORY_API_KEY = originalKey;
  });

  function expectRedacted(body: string) {
    expect(body).toContain("[REDACTED");
    for (const secret of [TOKEN, FACTORY_KEY, OTHER_PAT]) {
      expect(body).not.toContain(secret);
    }
  }

  test("redacts comment bodies", async () => {
    const { rest } = createOctokit(TOKEN);
    await rest.issues.createComment({
      owner: "o",
      repo: "r",
      issue_number: 1,
      body: LEAKY_TEXT,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("POST");
    expectRedacted(requests[0]!.body);
    // The credential the request authenticates with is left intact.
    expect(requests[0]!.headers.authorization).toContain(TOKEN);
  });

  test("redacts review comments nested in arrays", async () => {
    const { rest } = createOctokit(TOKEN);
    await rest.pulls.createReview({
      owner: "o",
      repo: "r",
      pull_number: 1,
      event: "COMMENT",
      body: "summary",
      comments: [{ path: "a.ts", line: 1, body: LEAKY_TEXT }],
    });

    expectRedacted(requests[0]!.body);
    expect(JSON.parse(requests[0]!.body).comments[0].path).toBe("a.ts");
  });

  test("redacts updates to PR descriptions and comments", async () => {
    const { rest } = createOctokit(TOKEN);
    await rest.pulls.update({
      owner: "o",
      repo: "r",
      pull_number: 1,
      body: LEAKY_TEXT,
    });
    await rest.issues.updateComment({
      owner: "o",
      repo: "r",
      comment_id: 2,
      body: LEAKY_TEXT,
    });

    expect(requests.map((r) => r.method)).toEqual(["PATCH", "PATCH"]);
    for (const request of requests) expectRedacted(request.body);
  });

  test("redacts GraphQL variables", async () => {
    const { graphql } = createOctokit(TOKEN);
    await graphql(
      `
        mutation ($threadId: ID!, $body: String!) {
          addPullRequestReviewThreadReply(
            input: { pullRequestReviewThreadId: $threadId, body: $body }
          ) {
            clientMutationId
          }
        }
      `,
      { threadId: "T_1", body: LEAKY_TEXT },
    );

    expectRedacted(requests[0]!.body);
    expect(JSON.parse(requests[0]!.body).variables.threadId).toBe("T_1");
    expect(requests[0]!.headers.authorization).toContain(TOKEN);
  });

  test("covers a standalone Octokit, its GraphQL client included", async () => {
    const octokit = withRequestRedaction(new Octokit({ auth: TOKEN }), TOKEN);
    await octokit.rest.issues.createComment({
      owner: "o",
      repo: "r",
      issue_number: 1,
      body: LEAKY_TEXT,
    });
    await octokit.graphql(`mutation ($body: String!) { x(body: $body) }`, {
      body: LEAKY_TEXT,
    });

    expect(requests).toHaveLength(2);
    for (const request of requests) expectRedacted(request.body);
  });
});
