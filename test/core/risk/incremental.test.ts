import { describe, expect, it } from "bun:test";
import {
  changedOwnPaths,
  importStem,
  importsModule,
  parseDiffFootprints,
} from "../../../src/core/risk/incremental";

const diffAt = (start: number, context: string) =>
  [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    `@@ -${start},2 +${start},2 @@ function outer() {`,
    ` ${context}`,
    "-  return 1;",
    "+  return 2;",
    "",
  ].join("\n");

describe("parseDiffFootprints", () => {
  it("keeps a change's footprint when only its position and context moved, and changes it when its lines did", () => {
    const prior = parseDiffFootprints(diffAt(10, "const a = 1;"));
    expect(
      changedOwnPaths(prior, parseDiffFootprints(diffAt(40, "const b = 1;"))),
    ).toEqual([]);
    expect(
      changedOwnPaths(
        prior,
        parseDiffFootprints(
          diffAt(10, "const a = 1;").replace("+  return 2;", "+  return 3;"),
        ),
      ),
    ).toEqual([{ path: "src/a.ts", change: "changed" }]);
    expect(
      changedOwnPaths(
        prior,
        parseDiffFootprints(diffAt(40, "x")),
        new Set(["src/a.ts"]),
      ),
    ).toEqual([{ path: "src/a.ts", change: "base_changed" }]);
  });

  it("tells files that joined or left the pull request apart, keyed by their new path", () => {
    const renamed = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");
    const binary = [
      "diff --git a/logo.png b/logo.png",
      "index 3333333..4444444 100644",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");
    const otherBinary = binary.replace("4444444", "5555555");
    expect(
      changedOwnPaths(
        parseDiffFootprints(binary + diffAt(1, "x")),
        parseDiffFootprints(otherBinary + renamed),
      ),
    ).toEqual([
      { path: "logo.png", change: "changed" },
      { path: "new.ts", previousPath: "old.ts", change: "added_to_pr" },
      { path: "src/a.ts", change: "removed_from_pr" },
    ]);
  });
});

describe("importsModule", () => {
  it("resolves relative specifiers against the importer and matches aliases by their last two segments", () => {
    const stem = importStem("apps/x/src/features/pr-risk/carry.ts");
    expect(stem).toBe("apps/x/src/features/pr-risk/carry");
    if (!stem) throw new Error("no stem");
    expect(
      importsModule("apps/x/src/features/pr-risk/begin.ts", "./carry", stem),
    ).toBe(true);
    expect(importsModule("apps/x/src/other/begin.ts", "./carry", stem)).toBe(
      false,
    );
    expect(
      importsModule("apps/x/src/a.ts", "@/features/pr-risk/carry.js", stem),
    ).toBe(true);
    expect(
      importsModule("apps/x/src/a.ts", "@/features/other/carry", stem),
    ).toBe(false);
    expect(importStem("src/lib/index.ts")).toBe("src/lib");
    expect(importsModule("src/main.ts", "./lib", "src/lib")).toBe(true);
    expect(importStem("README.md")).toBeNull();
  });
});
