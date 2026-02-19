import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  computeAndStoreDiff,
  fetchAndStoreComments,
  storeDescription,
  computeReviewArtifacts,
} from "../../../src/github/data/review-artifacts";
import * as childProcess from "child_process";
import * as fsPromises from "fs/promises";

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
    it("fetches issue and review comments and writes JSON", async () => {
      const mockOctokit = {
        rest: {
          issues: {
            listComments: () =>
              Promise.resolve({
                data: [{ id: 1, body: "issue comment" }],
              }),
          },
          pulls: {
            listReviewComments: () =>
              Promise.resolve({
                data: [{ id: 2, body: "review comment" }],
              }),
          },
        },
      } as any;

      const result = await fetchAndStoreComments(
        mockOctokit,
        "owner",
        "repo",
        42,
        "/tmp/test",
      );

      expect(result).toBe("/tmp/test/droid-prompts/existing_comments.json");
      const writeCall = writeFileSpy.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("existing_comments.json"),
      );
      expect(writeCall).toBeDefined();
      const written = JSON.parse(writeCall![1] as string);
      expect(written.issueComments).toHaveLength(1);
      expect(written.reviewComments).toHaveLength(1);
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
