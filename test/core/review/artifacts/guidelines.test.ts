import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fsPromises from "fs/promises";
import {
  loadStoredReviewGuidelines,
  prepareReviewGuidelines,
} from "../../../../src/core/review/artifacts/guidelines";

describe("prepareReviewGuidelines", () => {
  let writeFileSpy: ReturnType<typeof spyOn>;
  let mkdirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    writeFileSpy = spyOn(fsPromises, "writeFile").mockResolvedValue();
    mkdirSpy = spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
  });

  afterEach(() => {
    writeFileSpy.mockRestore();
    mkdirSpy.mockRestore();
  });

  it("asks the reader for the skill file on the given ref and stores the body", async () => {
    const calls: Array<[string, string]> = [];
    const result = await prepareReviewGuidelines({
      ref: "release/2.0",
      promptsDir: "/tmp/p",
      read: async (filePath, ref) => {
        calls.push([filePath, ref]);
        return "---\nname: review-guidelines\n---\n# Rules\n- one\n";
      },
    });

    expect(calls).toEqual([
      [".factory/skills/review-guidelines/SKILL.md", "release/2.0"],
    ]);
    expect(result).toEqual({
      source: ".factory/skills/review-guidelines/SKILL.md@release/2.0",
      body: "# Rules\n- one",
      path: "/tmp/p/review_guidelines.md",
    });
    expect(mkdirSpy).toHaveBeenCalledWith("/tmp/p", { recursive: true });
    expect(writeFileSpy).toHaveBeenCalledWith(
      "/tmp/p/review_guidelines.md",
      "# Rules\n- one",
    );
  });

  it("returns nothing when the file does not exist on the ref", async () => {
    const result = await prepareReviewGuidelines({
      ref: "main",
      promptsDir: "/tmp/p",
      read: async () => null,
    });

    expect(result).toBeUndefined();
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it("ignores a skill that is only frontmatter", async () => {
    const result = await prepareReviewGuidelines({
      ref: "main",
      promptsDir: "/tmp/p",
      read: async () => "---\nname: review-guidelines\n---\n",
    });

    expect(result).toBeUndefined();
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it("warns and continues when the reader fails", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const result = await prepareReviewGuidelines({
      ref: "main",
      promptsDir: "/tmp/p",
      read: async () => {
        throw new Error("rate limited");
      },
    });

    expect(result).toBeUndefined();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("rate limited");
    warnSpy.mockRestore();
  });
});

describe("loadStoredReviewGuidelines", () => {
  it("returns nothing when Pass 1 stored none", async () => {
    expect(await loadStoredReviewGuidelines(null)).toBeUndefined();
    expect(await loadStoredReviewGuidelines(undefined)).toBeUndefined();
  });

  it("reloads the body from the stored copy", async () => {
    const readSpy = spyOn(fsPromises, "readFile").mockResolvedValue(
      "# Rules\n- one" as never,
    );

    const result = await loadStoredReviewGuidelines({
      source: ".factory/skills/review-guidelines/SKILL.md@main",
      path: "/tmp/p/review_guidelines.md",
    });

    expect(readSpy).toHaveBeenCalledWith("/tmp/p/review_guidelines.md", "utf8");
    expect(result).toEqual({
      source: ".factory/skills/review-guidelines/SKILL.md@main",
      path: "/tmp/p/review_guidelines.md",
      body: "# Rules\n- one",
    });
    readSpy.mockRestore();
  });

  it("warns and continues when the stored copy is gone", async () => {
    const readSpy = spyOn(fsPromises, "readFile").mockRejectedValue(
      new Error("ENOENT"),
    );
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const result = await loadStoredReviewGuidelines({
      source: "x",
      path: "/tmp/p/missing.md",
    });

    expect(result).toBeUndefined();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("ENOENT");
    readSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
