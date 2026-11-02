import { describe, expect, it } from "bun:test";
import {
  changedFindingCandidates,
  changedReviewLines,
  reconcileFindings,
} from "../../src/core/review/incremental";
import { buildUnifiedDiffIndex } from "../../src/core/review/validated/diff";
import { normalizeFinding } from "../../src/core/review/validated/finding";
import { suggestedReviewersFromCodeowners } from "../../src/core/review/validated/metadata";

describe("all-comments shared changed-only diff projection", () => {
  it("indexes multiple headerless GitLab patches while excluding unchanged context", () => {
    const diff =
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -4,2 +4,2 @@\n-old\n+new\n context\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -8 +8 @@\n-before\n+after\n";
    const indexed = buildUnifiedDiffIndex(diff);
    const changed = changedReviewLines(diff);
    expect([...indexed.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(indexed.get("src/a.ts")?.oldLines.get(5)).toBe(5);
    expect([...changed.get("src/a.ts")!.oldLines]).toEqual([4]);
    expect([...changed.get("src/a.ts")!.newLines]).toEqual([4]);
    expect([...changed.get("src/b.ts")!.oldLines]).toEqual([8]);
  });

  it("preserves rename aliases and Unicode/quoted Git paths in combined diffs", () => {
    const diff =
      'diff --git "a/docs/\\303\\251.ts" "b/docs/😀.ts"\n--- "a/docs/\\303\\251.ts"\n+++ "b/docs/😀.ts"\n@@ -2,2 +2,2 @@\n-old\n+new\n context\n';
    const indexed = buildUnifiedDiffIndex(diff);
    const changed = changedReviewLines(diff);
    expect(indexed.get("docs/é.ts")).toBe(indexed.get("docs/😀.ts")!);
    expect(changed.get("docs/é.ts")).toBe(changed.get("docs/😀.ts")!);
    expect([...changed.get("docs/😀.ts")!.oldLines]).toEqual([2]);
    expect([...changed.get("docs/é.ts")!.newLines]).toEqual([2]);
    const previous = normalizeFinding({
      id: "renamed",
      path: "docs/😀.ts",
      old_path: "docs/é.ts",
      line: 2,
      side: "LEFT",
      title: "Unsafe old path",
      body: "Verified unsafe old code.",
    });
    expect(changedFindingCandidates([previous], diff)).toEqual([previous]);
  });

  it("projects additions/deletions and retains insertion-only LEFT eligibility", () => {
    const diff =
      "diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+restored\n" +
      "diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n";
    const changed = changedReviewLines(diff);
    expect([...changed.get("new.ts")!.oldLines]).toEqual([]);
    expect([...changed.get("new.ts")!.newLines]).toEqual([1]);
    expect([...changed.get("gone.ts")!.oldLines]).toEqual([1]);
    expect([...changed.get("gone.ts")!.newLines]).toEqual([]);
    const previous = normalizeFinding({
      id: "left",
      path: "new.ts",
      line: 99,
      side: "LEFT",
      title: "Missing guard",
      body: "The deleted guard protected the caller.",
    });
    expect(changedFindingCandidates([previous], diff)).toEqual([previous]);
    expect(
      reconcileFindings({
        previous: [previous],
        current: [],
        eligibleFixedIds: [previous.id],
        head: "new-head",
      }).resolved,
    ).toEqual([]);
  });

  it("does not grant context-only findings fix eligibility or confuse source markers with paths", () => {
    const diff =
      "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n--- old option\n+++ new option\n same\n--- a/context.txt\n+++ b/context.txt\n@@ -8 +8 @@\n same\n";
    const changed = changedReviewLines(diff);
    expect([...changed.keys()]).toEqual(["a.txt", "context.txt"]);
    expect([...changed.get("a.txt")!.oldLines]).toEqual([1]);
    expect([...changed.get("a.txt")!.newLines]).toEqual([1]);
    expect(changed.get("context.txt")!.oldLines.size).toBe(0);
    const previous = normalizeFinding({
      id: "context",
      path: "context.txt",
      line: 8,
      title: "Existing issue",
      body: "Unchanged code still has the issue.",
    });
    expect(changedFindingCandidates([previous], diff)).toEqual([]);
  });
});

describe("all-comments CODEOWNERS matching", () => {
  it("treats braces literally rather than expanding glob alternatives", () => {
    const content = "* @general\n/src/{client,server}/ @Literal\n";
    expect(
      suggestedReviewersFromCodeowners(content, ["src/client/a.ts"]),
    ).toEqual(["general"]);
    expect(
      suggestedReviewersFromCodeowners(content, ["src/server/a.ts"]),
    ).toEqual(["general"]);
    expect(
      suggestedReviewersFromCodeowners(content, ["src/{client,server}/a.ts"]),
    ).toEqual(["Literal"]);
  });
  it("preserves ordinary stars, directories, last matching rule and unsupported pattern rejection", () => {
    const content =
      "* @general\n/docs/ @writers\n*.ts @typescript\n!secret @negated\n[ab].ts @range\n/docs/private/\n";
    expect(
      suggestedReviewersFromCodeowners(content, [
        "src/a.ts",
        "docs/guide.md",
        "docs/private/key.md",
      ]),
    ).toEqual(["typescript", "writers"]);
    expect(
      suggestedReviewersFromCodeowners(content, ["docs/private/key.md"]),
    ).toEqual([]);
  });
  it("verifies and deduplicates users and teams case-insensitively while preserving first display spelling", () => {
    const content =
      "a.ts @Alice @Org/Platform @unknown\nb.ts @alice @org/PLATFORM\n";
    expect(
      suggestedReviewersFromCodeowners(
        content,
        ["a.ts", "b.ts"],
        ["@ALICE", "ORG/platform"],
      ),
    ).toEqual(["Alice", "Org/Platform"]);
    expect(
      suggestedReviewersFromCodeowners(content, ["a.ts", "b.ts"], []),
    ).toEqual([]);
    expect(suggestedReviewersFromCodeowners(content, ["a.ts", "b.ts"])).toEqual(
      ["Alice", "Org/Platform", "unknown"],
    );
  });
});
