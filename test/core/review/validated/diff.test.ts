import { describe, expect, it } from "bun:test";
import {
  buildFileLineIndex,
  buildUnifiedDiffIndex,
} from "../../../../src/core/review/validated/diff";

describe("buildFileLineIndex", () => {
  it("classifies additions, removals, context, and multiple hunks", () => {
    const index = buildFileLineIndex(
      "@@ -8,5 +8,5 @@\n a\n b\n+c\n d\n-e\n f\n" +
        "@@ -30,1 +31,2 @@\n x\n+y\n",
    );

    expect(index.newLines.get(10)).toBe("added");
    expect(index.newLines.get(11)).toBe(10);
    expect(index.oldLines.get(11)).toBe("removed");
    expect(index.oldLines.get(12)).toBe(12);
    expect(index.newLines.get(31)).toBe(30);
    expect(index.newLines.get(32)).toBe("added");
  });
});

describe("buildUnifiedDiffIndex", () => {
  it("splits a combined diff and registers renames under both paths", () => {
    const index = buildUnifiedDiffIndex(`diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-old
+new
 context
diff --git a/src/old name.ts b/src/new name.ts
similarity index 90%
rename from src/old name.ts
rename to src/new name.ts
--- a/src/old name.ts
+++ b/src/new name.ts
@@ -4 +4 @@
-before
+after
`);

    expect(index.get("src/a.ts")!.oldLines.get(1)).toBe("removed");
    expect(index.get("src/a.ts")!.newLines.get(1)).toBe("added");
    expect(index.get("src/a.ts")!.newLines.get(2)).toBe(2);
    expect(index.get("src/old name.ts")!).toBe(index.get("src/new name.ts")!);
    expect(index.get("src/new name.ts")!.newLines.get(4)).toBe("added");
  });

  it("handles new, deleted, and quoted UTF-8 paths", () => {
    const index = buildUnifiedDiffIndex(`diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1 @@
+new
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git "a/docs/\\303\\251.txt" "b/docs/\\303\\251.txt"
--- "a/docs/\\303\\251.txt"
+++ "b/docs/\\303\\251.txt"
@@ -1 +1 @@
-old
+new
`);

    expect(index.get("new.ts")!.newLines.get(1)).toBe("added");
    expect(index.get("gone.ts")!.oldLines.get(1)).toBe("removed");
    expect(index.get("docs/é.txt")!.newLines.get(1)).toBe("added");
  });

  it("does not mistake source lines for file path markers", () => {
    const index = buildUnifiedDiffIndex(`diff --git a/options.txt b/options.txt
--- a/options.txt
+++ b/options.txt
@@ -1 +1 @@
--- old option
+++ new option
`);

    expect(index.has("options.txt")).toBe(true);
    expect(index.has("old option")).toBe(false);
    expect(index.has("new option")).toBe(false);
  });
});
