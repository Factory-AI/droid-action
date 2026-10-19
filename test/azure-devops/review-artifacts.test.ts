import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  flattenThreads,
  resolveDiffRange,
  selectIteration,
  writeAzureDevopsReviewArtifacts,
} from "../../src/azure-devops/data/review-artifacts";
import {
  CommitNotAvailableError,
  checkoutDetached,
  createGitRunner,
} from "../../src/azure-devops/git";
import { buildUnifiedDiffIndex } from "../../src/core/review/validated/diff";
import { createPrRepo, git, tempDir } from "./helpers";

const repo = createPrRepo();
const runner = createGitRunner(repo.dir);
afterAll(() => fs.rmSync(repo.dir, { recursive: true, force: true }));

const iteration = (id: number, source: string, common?: string) => ({
  id,
  sourceRefCommit: { commitId: source },
  targetRefCommit: { commitId: repo.target },
  ...(common ? { commonRefCommit: { commitId: common } } : {}),
});

describe("selectIteration", () => {
  it("picks the iteration matching the build's source commit", () => {
    const its = [iteration(2, "bbb"), iteration(1, "AAA"), iteration(3, "ccc")];
    expect(selectIteration(its, "aaa").id).toBe(1);
  });
  it("falls back to the latest iteration when the build has no source commit", () => {
    const its = [iteration(2, "bbb"), iteration(3, "ccc"), iteration(1, "aaa")];
    expect(selectIteration(its, null).id).toBe(3);
  });
  it("refuses to review another iteration than the queued commit's", () => {
    const its = [iteration(2, "bbb"), iteration(3, "ccc"), iteration(1, "aaa")];
    expect(() => selectIteration(its, "zzz")).toThrow(
      "No pull request iteration has source commit zzz (latest is iteration 3)",
    );
  });
  it("throws without iterations", () => {
    expect(() => selectIteration([], null)).toThrow("no iterations");
  });
});

describe("resolveDiffRange + diff", () => {
  it("diffs the source commit against the common commit, excluding target-only changes", async () => {
    const range = resolveDiffRange(
      runner,
      iteration(1, repo.source, repo.common),
    );
    expect(range).toEqual({ base: repo.common, head: repo.source });
    const out = tempDir("ado-artifacts-");
    const artifacts = await writeAzureDevopsReviewArtifacts({
      git: runner,
      pr: {
        pullRequestId: 17,
        status: "active",
        title: "Add line4",
        description: "Body",
        sourceRefName: "refs/heads/feature",
        targetRefName: "refs/heads/main",
      },
      threads: [],
      range,
      outDir: out,
    });
    const diff = fs.readFileSync(artifacts.diffPath, "utf8");
    expect(diff).toContain("+line2 changed");
    expect(diff).toContain("deleted file mode");
    expect(diff).not.toContain("main-only.ts");
    const index = buildUnifiedDiffIndex(diff);
    expect(index.get("app.ts")?.newLines.get(4)).toBe("added");
    expect(index.get("old.ts")?.oldLines.get(1)).toBe("removed");
    expect(fs.readFileSync(artifacts.descriptionPath, "utf8")).toBe(
      "Title: Add line4\n\nBody\n",
    );
    expect(path.basename(artifacts.diffPath)).toBe("pr.diff");
  });

  it("computes the merge base when the iteration has no common commit", () => {
    const range = resolveDiffRange(runner, iteration(1, repo.source));
    expect(range.base).toBe(repo.common);
  });

  it("explains a shallow checkout", () => {
    expect(() =>
      resolveDiffRange(
        runner,
        iteration(1, "0123456789abcdef0123456789abcdef01234567", repo.common),
      ),
    ).toThrow(CommitNotAvailableError);
    expect(() =>
      resolveDiffRange(
        runner,
        iteration(1, "0123456789abcdef0123456789abcdef01234567"),
      ),
    ).toThrow("fetchDepth: 0");
  });

  it("checks out the source commit detached", () => {
    checkoutDetached(runner, repo.source);
    expect(git(repo.dir, "rev-parse", "HEAD")).toBe(repo.source);
    expect(fs.readFileSync(path.join(repo.dir, "app.ts"), "utf8")).toContain(
      "line4",
    );
  });
});

describe("flattenThreads", () => {
  it("keeps human comments with their file position and drops system/deleted ones", () => {
    const out = flattenThreads([
      {
        id: 1,
        status: "active",
        threadContext: {
          filePath: "/src/a.ts",
          rightFileStart: { line: 4, offset: 1 },
          rightFileEnd: { line: 6, offset: 1 },
        },
        comments: [
          {
            id: 1,
            content: "Looks off",
            author: { id: "u", displayName: "Bo" },
            commentType: "text",
            publishedDate: "2026-10-01T00:00:00Z",
          },
          { id: 2, content: "gone", isDeleted: true },
        ],
      },
      {
        id: 2,
        comments: [{ id: 1, content: "Ada voted 10", commentType: "system" }],
      },
      { id: 3, isDeleted: true, comments: [{ id: 1, content: "x" }] },
    ]);
    expect(out).toEqual([
      {
        threadId: 1,
        status: "active",
        filePath: "src/a.ts",
        line: 6,
        side: "RIGHT",
        comments: [
          {
            id: 1,
            author: "Bo",
            content: "Looks off",
            publishedDate: "2026-10-01T00:00:00Z",
          },
        ],
      },
    ]);
  });
});
