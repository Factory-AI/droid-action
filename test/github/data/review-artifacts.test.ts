import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  computeAndStoreDiff,
  fetchAndStoreComments,
  storeDescription,
  computeReviewArtifacts,
} from "../../../src/github/data/review-artifacts";
import * as childProcess from "child_process";
import * as fsPromises from "fs/promises";
import { Octokit } from "@octokit/rest";

describe("review-artifacts", () => {
  let execSyncSpy: ReturnType<typeof spyOn>;
  let writeFileSpy: ReturnType<typeof spyOn>;
  let mkdirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    writeFileSpy = spyOn(fsPromises, "writeFile").mockResolvedValue();
    mkdirSpy = spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
  });

  afterEach(() => {
    execSyncSpy?.mockRestore();
    writeFileSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  describe("computeAndStoreDiff", () => {
    it("computes diff via git merge-base and writes to disk", async () => {
      execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
        cmd: string,
      ) => {
        if (cmd.includes("is-shallow-repository")) return "false\n";
        if (cmd.includes("fetch origin main")) return "";
        if (cmd.includes("merge-base")) return "abc123\n";
        if (cmd.includes("diff")) return "diff --git a/f.ts b/f.ts\n+line\n";
        return "";
      }) as typeof childProcess.execSync);

      const result = await computeAndStoreDiff("main", "/tmp/test");

      expect(result).toBe("/tmp/test/droid-prompts/pr.diff");
      expect(mkdirSpy).toHaveBeenCalledWith("/tmp/test/droid-prompts", {
        recursive: true,
      });
      const writeCall = writeFileSpy.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" && (c[0] as string).includes("pr.diff"),
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![1]).toContain("diff --git");
    });

    it("falls back to gh pr diff when merge-base fails", async () => {
      execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
        cmd: string,
        opts?: any,
      ) => {
        if (cmd.includes("is-shallow-repository")) return "false\n";
        if (cmd.includes("merge-base")) throw new Error("no merge base");
        if (cmd.includes("gh pr diff")) {
          expect(opts?.env?.GH_TOKEN).toBe("test-token");
          return "diff from gh cli\n";
        }
        return "";
      }) as typeof childProcess.execSync);

      const result = await computeAndStoreDiff("main", "/tmp/test", {
        githubToken: "test-token",
        prNumber: 42,
      });

      expect(result).toBe("/tmp/test/droid-prompts/pr.diff");
      const writeCall = writeFileSpy.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" && (c[0] as string).includes("pr.diff"),
      );
      expect(writeCall![1]).toContain("diff from gh cli");
    });

    // actions/checkout may not have persisted a credential, so with a token
    // the fetches authenticate through gh instead.
    it("authenticates its fetches through gh when given a token", async () => {
      const fetches: { cmd: string; token?: string }[] = [];
      execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
        cmd: string,
        opts?: any,
      ) => {
        if (cmd.includes("is-shallow-repository")) return "true\n";
        if (cmd.includes(" fetch ")) {
          fetches.push({ cmd, token: opts?.env?.GH_TOKEN });
          return "";
        }
        if (cmd.includes("merge-base")) return "abc123\n";
        if (cmd.includes("diff")) return "diff --git a/f.ts b/f.ts\n";
        return "";
      }) as typeof childProcess.execSync);

      await computeAndStoreDiff("main", "/tmp/test", {
        githubToken: "test-token",
        prNumber: 42,
      });

      expect(fetches).toHaveLength(2);
      for (const fetch of fetches) {
        expect(fetch.cmd).toContain(
          "credential.helper=!gh auth git-credential",
        );
        expect(fetch.token).toBe("test-token");
      }
    });

    it("throws when merge-base fails and no fallback credentials", async () => {
      execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
        cmd: string,
      ) => {
        if (cmd.includes("is-shallow-repository")) return "false\n";
        if (cmd.includes("merge-base")) throw new Error("no merge base");
        return "";
      }) as typeof childProcess.execSync);

      await expect(computeAndStoreDiff("main", "/tmp/test")).rejects.toThrow(
        "no fallback credentials",
      );
    });
  });

  describe("fetchAndStoreComments", () => {
    // A real Octokit whose HTTP layer serves `per_page` sized pages with
    // GitHub-style Link headers, so the paginator is exercised end to end.
    function pagedOctokit(
      totals: Record<string, number>,
      failPage?: { path: string; page: number },
    ) {
      const requested: string[] = [];
      const fetch = async (input: string | URL | Request) => {
        const url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
        requested.push(`${url.pathname}?${url.searchParams}`);
        const path = url.pathname;
        const page = Number(url.searchParams.get("page") ?? "1");
        const perPage = Number(url.searchParams.get("per_page") ?? "30");
        if (failPage && failPage.path === path && failPage.page === page) {
          return new Response(JSON.stringify({ message: "boom" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        const total = totals[path] ?? 0;
        const first = (page - 1) * perPage;
        const items = Array.from(
          { length: Math.max(0, Math.min(perPage, total - first)) },
          (_, i) => ({ id: first + i + 1, body: `${path} #${first + i + 1}` }),
        );
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (first + perPage < total) {
          const next = new URL(url);
          next.searchParams.set("page", String(page + 1));
          headers.link = `<${next}>; rel="next"`;
        }
        return new Response(JSON.stringify(items), { status: 200, headers });
      };
      const rest = new Octokit({
        baseUrl: "https://api.github.test",
        request: { fetch, retries: 0 },
      });
      return { octokit: { rest } as any, requested };
    }

    const ISSUE_PATH = "/repos/owner/repo/issues/42/comments";
    const REVIEW_PATH = "/repos/owner/repo/pulls/42/comments";

    function writtenComments() {
      const writeCall = writeFileSpy.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("existing_comments.json"),
      );
      expect(writeCall).toBeDefined();
      return JSON.parse(writeCall![1] as string);
    }

    it("fetches issue and review comments and writes JSON", async () => {
      const { octokit } = pagedOctokit({ [ISSUE_PATH]: 1, [REVIEW_PATH]: 1 });

      const result = await fetchAndStoreComments(
        octokit,
        "owner",
        "repo",
        42,
        "/tmp/test",
      );

      expect(result).toBe("/tmp/test/droid-prompts/existing_comments.json");
      const written = writtenComments();
      expect(written.issueComments).toHaveLength(1);
      expect(written.reviewComments).toHaveLength(1);
    });

    it("follows pagination past the first 100 comments on both endpoints", async () => {
      const { octokit, requested } = pagedOctokit({
        [ISSUE_PATH]: 205,
        [REVIEW_PATH]: 103,
      });

      await fetchAndStoreComments(octokit, "owner", "repo", 42, "/tmp/test");

      const written = writtenComments();
      expect(written.issueComments).toHaveLength(205);
      expect(written.reviewComments).toHaveLength(103);
      // Order is preserved and the last comment (e.g. a late author reply)
      // is present.
      expect(written.issueComments.map((c: any) => c.id)).toEqual(
        Array.from({ length: 205 }, (_, i) => i + 1),
      );
      expect(written.reviewComments.at(-1).id).toBe(103);
      expect(requested.filter((r) => r.startsWith(ISSUE_PATH))).toHaveLength(3);
      expect(requested.filter((r) => r.startsWith(REVIEW_PATH))).toHaveLength(
        2,
      );
    });

    it("does not request a second page for exactly 100 comments", async () => {
      const { octokit, requested } = pagedOctokit({
        [ISSUE_PATH]: 100,
        [REVIEW_PATH]: 0,
      });

      await fetchAndStoreComments(octokit, "owner", "repo", 42, "/tmp/test");

      const written = writtenComments();
      expect(written.issueComments).toHaveLength(100);
      expect(written.reviewComments).toHaveLength(0);
      expect(requested.filter((r) => r.startsWith(ISSUE_PATH))).toHaveLength(1);
    });

    it("rejects instead of writing a partial history when a later page fails", async () => {
      const { octokit } = pagedOctokit(
        { [ISSUE_PATH]: 150, [REVIEW_PATH]: 1 },
        { path: ISSUE_PATH, page: 2 },
      );

      await expect(
        fetchAndStoreComments(octokit, "owner", "repo", 42, "/tmp/test"),
      ).rejects.toThrow();
      const writeCall = writeFileSpy.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("existing_comments.json"),
      );
      expect(writeCall).toBeUndefined();
    });
  });

  describe("storeDescription", () => {
    it("writes PR title and body as markdown", async () => {
      const result = await storeDescription(
        "My Feature",
        "Adds cool stuff",
        "/tmp/test",
      );

      expect(result).toBe("/tmp/test/droid-prompts/pr_description.txt");
      const writeCall = writeFileSpy.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("pr_description.txt"),
      );
      expect(writeCall).toBeDefined();
      expect(writeCall![1]).toBe("# My Feature\n\nAdds cool stuff");
    });

    it("handles empty body", async () => {
      await storeDescription("Title Only", "", "/tmp/test");

      const writeCall = writeFileSpy.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("pr_description.txt"),
      );
      expect(writeCall![1]).toBe("# Title Only\n\n");
    });
  });

  describe("computeReviewArtifacts", () => {
    it("runs all three artifact computations in parallel", async () => {
      execSyncSpy = spyOn(childProcess, "execSync").mockImplementation(((
        cmd: string,
      ) => {
        if (cmd.includes("is-shallow-repository")) return "false\n";
        if (cmd.includes("merge-base")) return "abc123\n";
        if (cmd.includes("diff")) return "some diff\n";
        return "";
      }) as typeof childProcess.execSync);

      const mockOctokit = {
        rest: {
          paginate: async (method: any, params: any) =>
            (await method(params)).data,
          issues: {
            listComments: () => Promise.resolve({ data: [] }),
          },
          pulls: {
            listReviewComments: () => Promise.resolve({ data: [] }),
          },
        },
      } as any;

      const result = await computeReviewArtifacts({
        baseRef: "main",
        tempDir: "/tmp/test",
        octokit: mockOctokit,
        owner: "owner",
        repo: "repo",
        prNumber: 99,
        title: "Test PR",
        body: "Test body",
        githubToken: "token",
      });

      expect(result.diffPath).toContain("pr.diff");
      expect(result.commentsPath).toContain("existing_comments.json");
      expect(result.descriptionPath).toContain("pr_description.txt");
    });
  });
});
