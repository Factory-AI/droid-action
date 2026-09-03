import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { graphql } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import type { Octokits } from "../../../src/github/api/client";
import {
  fetchPRBranchData,
  fetchRepoDefaultBranch,
} from "../../../src/github/data/pr-fetcher";

type StubResponse = {
  status?: number;
  contentType?: string;
  body: string;
};

/**
 * Builds an Octokits whose GraphQL client talks to a stubbed fetch, so the real
 * @octokit/graphql envelope handling stays under test.
 */
function createStubOctokits(responses: StubResponse[]): {
  octokits: Octokits;
  requestCount: () => number;
} {
  let calls = 0;

  const stubFetch = async () => {
    const response = responses[Math.min(calls, responses.length - 1)]!;
    calls += 1;
    return new Response(response.body, {
      status: response.status ?? 200,
      headers: {
        "content-type": response.contentType ?? "application/json",
      },
    });
  };

  return {
    octokits: {
      rest: new Octokit({ auth: "stub-token" }),
      graphql: graphql.defaults({
        headers: { authorization: "token stub-token" },
        request: { fetch: stubFetch },
      }),
    },
    requestCount: () => calls,
  };
}

function prEnvelope(pullRequest: Record<string, unknown> | null): StubResponse {
  return { body: JSON.stringify({ data: { repository: { pullRequest } } }) };
}

const VALID_PR = {
  title: "fix(frontend): stabilize session navigation",
  body: "description",
  baseRefName: "dev",
  headRefName: "ross/app-1930-session-nav",
  headRefOid: "abc123",
};

const REPOSITORY = { owner: "Factory-AI", repo: "factory-mono" };

describe("pr-fetcher", () => {
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("fetchPRBranchData", () => {
    it("returns the branch data from a well formed response", async () => {
      const { octokits, requestCount } = createStubOctokits([
        prEnvelope(VALID_PR),
      ]);

      const result = await fetchPRBranchData({
        octokits,
        repository: REPOSITORY,
        prNumber: 19051,
      });

      expect(result).toEqual({
        baseRefName: "dev",
        headRefName: "ross/app-1930-session-nav",
        headRefOid: "abc123",
        title: "fix(frontend): stabilize session navigation",
        body: "description",
      });
      expect(requestCount()).toBe(1);
    });

    it("defaults a null PR body to an empty string", async () => {
      const { octokits } = createStubOctokits([
        prEnvelope({ ...VALID_PR, body: null }),
      ]);

      const result = await fetchPRBranchData({
        octokits,
        repository: REPOSITORY,
        prNumber: 19051,
      });

      expect(result.body).toBe("");
    });

    it("reports the response instead of crashing when a 200 carries no GraphQL envelope", async () => {
      const { octokits } = createStubOctokits([
        {
          contentType: "text/html",
          body: "<html><body>unavailable</body></html>",
        },
      ]);

      const error = await fetchPRBranchData({
        octokits,
        repository: REPOSITORY,
        prNumber: 19051,
      }).then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );

      expect(error).toBeDefined();
      // The crash signature this guards against: a TypeError from
      // dereferencing `prResult.repository` on an undefined payload.
      expect(error!.message).not.toContain("is not an object");
      expect(error!.message).toContain(
        'PR query for Factory-AI/factory-mono#19051 returned no "repository" field',
      );
      expect(error!.message).toContain("HTTP 200 text/html");
      expect(error!.message).toContain("<html><body>unavailable</body>");
      expect(error!.message).toContain(
        "Failed to fetch PR branch data for PR #19051",
      );
    }, 15000);

    it("reports the response when a 200 body is JSON without a data member", async () => {
      const { octokits } = createStubOctokits([{ body: "{}" }]);

      const error = await fetchPRBranchData({
        octokits,
        repository: REPOSITORY,
        prNumber: 19051,
      }).then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );

      expect(error).toBeDefined();
      expect(error!.message).not.toContain("is not an object");
      expect(error!.message).toContain('returned no "repository" field');
    }, 15000);

    it("recovers when only the first attempt returns a malformed response", async () => {
      const { octokits, requestCount } = createStubOctokits([
        { contentType: "text/html", body: "<html>unavailable</html>" },
        prEnvelope(VALID_PR),
      ]);

      const result = await fetchPRBranchData({
        octokits,
        repository: REPOSITORY,
        prNumber: 19051,
      });

      expect(result.headRefName).toBe("ross/app-1930-session-nav");
      expect(requestCount()).toBe(2);
    }, 15000);

    it("does not retry a null repository, which is a stable answer", async () => {
      const { octokits, requestCount } = createStubOctokits([
        { body: JSON.stringify({ data: { repository: null } }) },
      ]);

      const error = await fetchPRBranchData({
        octokits,
        repository: REPOSITORY,
        prNumber: 19051,
      }).then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );

      expect(error).toBeDefined();
      expect(error!.message).not.toContain("is not an object");
      expect(error!.message).toContain("PR #19051 not found");
      expect(requestCount()).toBe(1);
    });

    it("does not retry a null pull request, which is a stable answer", async () => {
      const { octokits, requestCount } = createStubOctokits([prEnvelope(null)]);

      const error = await fetchPRBranchData({
        octokits,
        repository: REPOSITORY,
        prNumber: 19051,
      }).then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );

      expect(error).toBeDefined();
      expect(error!.message).toContain("PR #19051 not found");
      expect(requestCount()).toBe(1);
    });

    it("surfaces GraphQL error messages returned alongside a null data member", async () => {
      const { octokits } = createStubOctokits([
        {
          body: JSON.stringify({
            data: null,
            errors: [{ message: "Bad credentials" }],
          }),
        },
      ]);

      const error = await fetchPRBranchData({
        octokits,
        repository: REPOSITORY,
        prNumber: 19051,
      }).then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );

      expect(error).toBeDefined();
      expect(error!.message).toContain("Bad credentials");
    }, 15000);
  });

  describe("fetchRepoDefaultBranch", () => {
    it("returns the default branch name", async () => {
      const { octokits } = createStubOctokits([
        {
          body: JSON.stringify({
            data: { repository: { defaultBranchRef: { name: "dev" } } },
          }),
        },
      ]);

      await expect(
        fetchRepoDefaultBranch({ octokits, repository: REPOSITORY }),
      ).resolves.toBe("dev");
    });

    it("reports the response instead of crashing when a 200 carries no GraphQL envelope", async () => {
      const { octokits } = createStubOctokits([
        { contentType: "text/html", body: "<html>unavailable</html>" },
      ]);

      const error = await fetchRepoDefaultBranch({
        octokits,
        repository: REPOSITORY,
      }).then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );

      expect(error).toBeDefined();
      expect(error!.message).not.toContain("is not an object");
      expect(error!.message).toContain(
        'Default branch query for Factory-AI/factory-mono returned no "repository" field',
      );
      expect(error!.message).toContain(
        "Failed to fetch default branch for Factory-AI/factory-mono",
      );
    }, 15000);

    it("does not retry a null repository, which is a stable answer", async () => {
      const { octokits, requestCount } = createStubOctokits([
        { body: JSON.stringify({ data: { repository: null } }) },
      ]);

      const error = await fetchRepoDefaultBranch({
        octokits,
        repository: REPOSITORY,
      }).then(
        () => undefined,
        (caught: unknown) => caught as Error,
      );

      expect(error).toBeDefined();
      expect(error!.message).toContain(
        "Default branch not found for Factory-AI/factory-mono",
      );
      expect(requestCount()).toBe(1);
    });
  });
});
