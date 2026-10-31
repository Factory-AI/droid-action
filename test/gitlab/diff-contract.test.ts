import { describe, expect, it } from "bun:test";
import {
  changedFindingCandidates,
  changedReviewLines,
} from "../../src/core/review/incremental";
import { normalizeFinding } from "../../src/core/review/validated/finding";
import { buildDiffContent } from "../../src/gitlab/data/review-artifacts";
import type { GitlabMrDiff } from "../../src/gitlab/types";

const replacement = "@@ -9,3 +9,3 @@\n before\n-old\n+new\n after\n";
function change(overrides: Partial<GitlabMrDiff> = {}): GitlabMrDiff {
  return {
    old_path: "src/x.ts",
    new_path: "src/x.ts",
    a_mode: "100644",
    b_mode: "100644",
    new_file: false,
    renamed_file: false,
    deleted_file: false,
    diff: replacement,
    ...overrides,
  };
}
function artifact(changes: GitlabMrDiff[]): string {
  return buildDiffContent({
    changes,
    diff_refs: {
      base_sha: "b".repeat(40),
      head_sha: "a".repeat(40),
      start_sha: "b".repeat(40),
    },
  });
}
function finding(id: string, line: number | null, path = "src/x.ts") {
  return normalizeFinding({ id, path, line, title: id, severity: "P1" });
}

describe("GitLab API diff contract", () => {
  it("indexes only removed old-side lines from an @@-only API patch", () => {
    const diff = artifact([change()]);
    const lines = changedReviewLines(diff).get("src/x.ts");
    expect([...lines!.oldLines]).toEqual([10]);
    expect([...lines!.newLines]).toEqual([10]);
    expect(
      changedFindingCandidates(
        [
          finding("changed", 10),
          { ...finding("range", 10), startLine: 9 },
          finding("context-before", 9),
          finding("context-after", 11),
          finding("outside-hunk", 12),
          finding("another-file", 10, "src/other.ts"),
        ],
        diff,
      ).map((f) => f.id),
    ).toEqual(["changed", "range"]);
  });

  it("preserves both names for renamed files", () => {
    const diff = artifact([
      change({
        old_path: "src/old.ts",
        new_path: "src/new.ts",
        renamed_file: true,
      }),
    ]);
    const lines = changedReviewLines(diff);
    expect(lines.get("src/old.ts")).toBeDefined();
    expect(lines.get("src/new.ts") === lines.get("src/old.ts")).toBe(true);
    expect(
      changedFindingCandidates(
        [
          finding("old-name", 10, "src/old.ts"),
          {
            ...finding("new-name", 10, "src/new.ts"),
            oldPath: "src/old.ts",
          },
        ],
        diff,
      ).map((f) => f.id),
    ).toEqual(["old-name", "new-name"]);
  });

  it("uses /dev/null for a deletion without inventing a new-side path", () => {
    const diff = artifact([
      change({ deleted_file: true, diff: "@@ -1,2 +0,0 @@\n-one\n-two\n" }),
    ]);
    const lines = changedReviewLines(diff);
    expect(diff).toContain("\n+++ /dev/null\n");
    expect([...lines.get("src/x.ts")!.oldLines]).toEqual([1, 2]);
    expect(lines.get("src/x.ts")!.newLines.size).toBe(0);
    expect(lines.has("/dev/null")).toBe(false);
    expect(
      changedFindingCandidates([finding("deleted", 2)], diff),
    ).toHaveLength(1);
  });

  it("does not treat additions in a new file as changed old code", () => {
    const diff = artifact([
      change({
        old_path: "",
        new_file: true,
        diff: "@@ -0,0 +1,2 @@\n+one\n+two\n",
      }),
    ]);
    const lines = changedReviewLines(diff);
    expect(diff).toContain("\n--- /dev/null\n");
    expect(lines.get("src/x.ts")?.oldLines.size).toBe(0);
    expect([...lines.get("src/x.ts")!.newLines]).toEqual([1, 2]);
    expect(changedFindingCandidates([finding("not-old", 1)], diff)).toEqual([]);
  });

  it("keeps line sets separate across multiple files and hunks", () => {
    const diff = artifact([
      change(),
      change({
        old_path: "src/y.ts",
        new_path: "src/y.ts",
        diff: "@@ -20 +20 @@\n-old\n+new\n@@ -40 +40 @@\n-old\n+new",
      }),
    ]);
    const lines = changedReviewLines(diff);
    expect([...lines.get("src/x.ts")!.oldLines]).toEqual([10]);
    expect([...lines.get("src/y.ts")!.oldLines]).toEqual([20, 40]);
    expect(
      changedFindingCandidates([finding("wrong-file-line", 20)], diff),
    ).toEqual([]);
  });

  for (const diff of [
    "",
    "Binary files differ\n",
    "rename from x\nrename to y\n",
  ])
    it(`does not make a no-hunk patch eligible: ${JSON.stringify(diff)}`, () => {
      const content = artifact([change({ diff })]);
      expect(changedReviewLines(content).size).toBe(0);
      expect(
        changedFindingCandidates([finding("unanchored", null)], content),
      ).toEqual([]);
    });

  it("does not mistake deleted -- text for an existing file header", () => {
    const diff = artifact([
      change({
        diff: "@@ -10 +10 @@\n--- old SQL comment\n+++ new SQL comment\n",
      }),
    ]);
    expect([...changedReviewLines(diff).get("src/x.ts")!.oldLines]).toEqual([
      10,
    ]);
  });

  it("preserves a pre-existing unified patch and native GitHub parsing", () => {
    const patch = `--- a/src/x.ts\n+++ b/src/x.ts\n${replacement}`;
    const native = `diff --git a/src/x.ts b/src/x.ts\n${patch}`;
    const diff = artifact([change({ diff: patch })]);
    expect(diff).toBe(native);
    expect([...changedReviewLines(native).get("src/x.ts")!.oldLines]).toEqual([
      10,
    ]);
  });

  for (const file of [
    'src/with\t"quote\nname.ts',
    "src/vertical\vname.ts",
    "src/emoji 🚀.ts",
  ])
    it(`round-trips quoted API paths: ${JSON.stringify(file)}`, () => {
      const diff = artifact([change({ old_path: file, new_path: file })]);
      expect([...changedReviewLines(diff).keys()]).toEqual([file]);
      expect(
        changedFindingCandidates([finding("quoted", 10, file)], diff),
      ).toHaveLength(1);
    });
});
