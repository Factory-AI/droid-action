import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import type { Octokits } from "../../../src/github/api/client";
import { fetchPullRequestRiskSummary } from "../../../src/github/data/pr-risk";

type StubResponse = { status?: number; body: unknown };

/**
 * Builds an Octokits whose REST client talks to a stubbed fetch, so the real
 * Octokit request and error handling stay under test.
 */
function createStubOctokits(responses: StubResponse[]) {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const stubFetch = async (url: string, init: RequestInit) => {
    const response =
      responses[Math.min(requests.length, responses.length - 1)]!;
    requests.push({
      url,
      authorization: new Headers(init.headers).get("authorization"),
    });
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  const octokits: Octokits = {
    rest: new Octokit({ auth: "stub-token", request: { fetch: stubFetch } }),
    graphql,
  };
  return { octokits, requests };
}

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const PULL_REQUEST = {
  title: "Rotate sessions safely",
  additions: 430,
  deletions: 90,
  changed_files: 7,
  head: { sha: HEAD },
  base: { sha: BASE },
};
const TARGET = { repository: { owner: "acme", repo: "app" }, prNumber: 12 };

describe("fetchPullRequestRiskSummary", () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let consoleLogSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  it("reads one pull request's commits, title and counts with the token it is given", async () => {
    const { octokits, requests } = createStubOctokits([{ body: PULL_REQUEST }]);

    expect(await fetchPullRequestRiskSummary({ octokits, ...TARGET })).toEqual({
      headSha: HEAD,
      baseSha: BASE,
      pullRequest: {
        title: "Rotate sessions safely",
        additions: 430,
        deletions: 90,
        changedFiles: 7,
      },
    });
    expect(requests).toEqual([
      {
        url: "https://api.github.com/repos/acme/app/pulls/12",
        authorization: "token stub-token",
      },
    ]);
  });

  it("asks again when GitHub answers with a server error", async () => {
    const { octokits, requests } = createStubOctokits([
      { status: 502, body: { message: "Bad Gateway" } },
      { body: PULL_REQUEST },
    ]);

    expect(
      await fetchPullRequestRiskSummary({ octokits, ...TARGET }),
    ).toMatchObject({ headSha: HEAD });
    expect(requests).toHaveLength(2);
  }, 15000);

  it("does not ask again for an answer that will not change, and labels the failure", async () => {
    const { octokits, requests } = createStubOctokits([
      { status: 404, body: { message: "Not Found" } },
    ]);

    await expect(
      fetchPullRequestRiskSummary({ octokits, ...TARGET }),
    ).rejects.toMatchObject({
      reason: "pr_metadata_unavailable",
      message: "GitHub did not return acme/app#12: Not Found",
    });
    expect(requests).toHaveLength(1);
  });

  it("rejects an answer that is not a pull request", async () => {
    const { octokits } = createStubOctokits([
      { body: { ...PULL_REQUEST, head: {} } },
    ]);

    await expect(
      fetchPullRequestRiskSummary({ octokits, ...TARGET }),
    ).rejects.toThrow();
  });
});
