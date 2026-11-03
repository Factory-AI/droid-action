import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import * as childProcess from "child_process";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  computeAndStoreDiff,
  computeReviewArtifacts,
} from "../../../src/github/data/review-artifacts";
import type { Octokits } from "../../../src/github/api/client";

const OLD = "b".repeat(40);
const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);

describe("incremental safety: model artifact boundaries", () => {
  let directory: string;
  let savedEnv: NodeJS.ProcessEnv;
  beforeEach(async () => {
    savedEnv = { ...process.env };
    directory = await mkdtemp(join(tmpdir(), "incremental-safety-g2-"));
    delete process.env.REVIEW_CONFIG;
    delete process.env.REVIEW_IGNORE_PATHS;
    process.env.REVIEW_LIFECYCLE_PATH = join(
      directory,
      "missing-lifecycle.json",
    );
  });
  afterEach(async () => {
    mock.restore();
    for (const key of Object.keys(process.env))
      if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(directory, { recursive: true, force: true });
  });
  function git(diff: string, diverged = false) {
    return spyOn(childProcess, "execSync").mockImplementation(((
      command: string,
    ) => {
      if (command.includes("--is-shallow-repository")) return "false\n";
      if (command.includes("--is-ancestor")) {
        if (diverged) throw new Error("Synthetic divergent history");
        return "";
      }
      if (command.includes("cat-file")) return "";
      if (command.includes("merge-base")) return BASE;
      if (command.includes("--no-pager diff")) return diff;
      return "";
    }) as typeof childProcess.execSync);
  }
  it("keeps a divergent available previous tree as the actual incremental baseline", async () => {
    const exec = git("synthetic direct prior diff\n", true);
    let selected: [string, boolean] | undefined;
    await computeAndStoreDiff("main", directory, {
      incrementalBaseSha: OLD,
      headRevision: HEAD,
      onRangeSelected: (base, incremental) => {
        selected = [base, incremental];
      },
    });
    expect(selected).toEqual([OLD, true]);
    expect(
      exec.mock.calls.some(
        ([command]) => command === `git --no-pager diff ${OLD}..${HEAD}`,
      ),
    ).toBe(true);
  });
  it("retains full-review merge-base behavior without a requested incremental base", async () => {
    const exec = git("synthetic full diff\n", true);
    let selected: [string, boolean] | undefined;
    await computeAndStoreDiff("main", directory, {
      headRevision: HEAD,
      onRangeSelected: (base, incremental) => {
        selected = [base, incremental];
      },
    });
    expect(selected).toEqual([BASE, false]);
    expect(
      exec.mock.calls.some(
        ([command]) => command === `git --no-pager diff ${BASE}..${HEAD}`,
      ),
    ).toBe(true);
  });
  it("keeps valid ancestor incremental reviews on the previous tree", async () => {
    const exec = git("synthetic ancestor diff\n");
    let selected: [string, boolean] | undefined;
    await computeAndStoreDiff("main", directory, {
      incrementalBaseSha: OLD,
      headRevision: HEAD,
      onRangeSelected: (base, incremental) => {
        selected = [base, incremental];
      },
    });
    expect(selected).toEqual([OLD, true]);
    expect(
      exec.mock.calls.some(
        ([command]) => command === `git --no-pager diff ${OLD}..${HEAD}`,
      ),
    ).toBe(true);
  });
  it("resets artifact range to the full PR if the prior commit is unavailable", async () => {
    const exec = git("synthetic full diff\n");
    exec.mockImplementation(((command: string) => {
      if (command.includes("cat-file") || command.includes("--is-ancestor"))
        throw new Error("Synthetic unavailable object");
      if (command.includes("--is-shallow-repository")) return "false\n";
      if (command.includes("merge-base")) return BASE;
      if (command.includes("--no-pager diff")) return "synthetic full diff\n";
      return "";
    }) as typeof childProcess.execSync);
    let selected: [string, boolean] | undefined;
    await computeAndStoreDiff("main", directory, {
      incrementalBaseSha: OLD,
      headRevision: HEAD,
      onRangeSelected: (base, incremental) => {
        selected = [base, incremental];
      },
    });
    expect(selected).toEqual([BASE, false]);
  });
  for (const [quoted, decoded] of [
    ['"b/dist/\\303\\251.ts"', "dist/é.ts"],
    ['"b/dist/a\\tb.ts"', "dist/a\tb.ts"],
    ['"b/dist/a\\"b.ts"', 'dist/a"b.ts'],
  ]) {
    it(`excludes a quoted ignored path before model access (${JSON.stringify(decoded)})`, async () => {
      const diff =
        `diff --git "a/dist/old.ts" ${quoted}\n--- "a/dist/old.ts"\n+++ ${quoted}\n@@ -1 +1 @@\n-SYNTHETIC_IGNORED_OLD\n+SYNTHETIC_IGNORED_NEW\n` +
        "diff --git a/src/space name.ts b/src/space name.ts\n--- a/src/space name.ts\n+++ b/src/space name.ts\n@@ -1 +1 @@\n-old\n+safe\n";
      git(diff);
      const octokit = {
        rest: {
          issues: { listComments: async () => ({ data: [] }) },
          pulls: { listReviewComments: async () => ({ data: [] }) },
        },
      } as unknown as Octokits;
      const result = await computeReviewArtifacts({
        baseRef: "main",
        tempDir: directory,
        octokit,
        owner: "o",
        repo: "r",
        prNumber: 7,
        title: "Synthetic",
        body: "",
        headRevision: HEAD,
      });
      const modelDiff = await readFile(result.diffPath, "utf8");
      expect(modelDiff.includes("SYNTHETIC_IGNORED")).toBe(false);
      expect(modelDiff.includes("src/space name.ts")).toBe(true);
      const manifest = JSON.parse(
        await readFile(
          join(directory, "droid-prompts/review_files.json"),
          "utf8",
        ),
      );
      expect(manifest).toEqual({
        reviewed: ["src/space name.ts"],
        skipped: [{ path: decoded, reason: "ignored by review_ignore_paths" }],
      });
    });
  }
  it("filters deleted and rename-only quoted ignored files while retaining allowed renames", async () => {
    const diff =
      'diff --git "a/dist/\\303\\251.ts" "b/dist/\\303\\251.ts"\ndeleted file mode 100644\n--- "a/dist/\\303\\251.ts"\n+++ /dev/null\n@@ -1 +0,0 @@\n-SYNTHETIC_IGNORED\n' +
      'diff --git "a/src/a\\tb.ts" "b/dist/a\\tb.ts"\nsimilarity index 100%\nrename from "src/a\\tb.ts"\nrename to "dist/a\\tb.ts"\n' +
      "diff --git a/src/old name.ts b/src/new name.ts\nsimilarity index 100%\nrename from src/old name.ts\nrename to src/new name.ts\n";
    git(diff);
    const octokit = {
      rest: {
        issues: { listComments: async () => ({ data: [] }) },
        pulls: { listReviewComments: async () => ({ data: [] }) },
      },
    } as unknown as Octokits;
    const result = await computeReviewArtifacts({
      baseRef: "main",
      tempDir: directory,
      octokit,
      owner: "o",
      repo: "r",
      prNumber: 7,
      title: "Synthetic",
      body: "",
      headRevision: HEAD,
    });
    const modelDiff = await readFile(result.diffPath, "utf8");
    expect(modelDiff.includes("SYNTHETIC_IGNORED")).toBe(false);
    expect(modelDiff.includes("dist/")).toBe(false);
    expect(modelDiff.includes("src/new name.ts")).toBe(true);
    const manifest = JSON.parse(
      await readFile(
        join(directory, "droid-prompts/review_files.json"),
        "utf8",
      ),
    );
    expect(manifest.reviewed).toEqual(["src/new name.ts"]);
    expect(
      manifest.skipped.map((entry: { path: string }) => entry.path),
    ).toEqual(["dist/é.ts", "dist/a\tb.ts"]);
  });
});
