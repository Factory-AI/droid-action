import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadReviewGuidelines } from "../../src/utils/review-guidelines";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";

describe("loadReviewGuidelines", () => {
  const testDir = join(process.cwd(), "__test_workspace__");
  const skillsDir = join(testDir, ".factory", "skills");
  const guidelinesPath = join(skillsDir, "review-guidelines.md");
  let originalWorkspace: string | undefined;

  beforeEach(async () => {
    originalWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = testDir;
    await mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    if (originalWorkspace === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = originalWorkspace;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it("returns content when review-guidelines.md exists", async () => {
    await writeFile(
      guidelinesPath,
      "- Always check error handling\n- Prefer const over let",
    );

    const result = await loadReviewGuidelines();

    expect(result).toBe(
      "- Always check error handling\n- Prefer const over let",
    );
  });

  it("returns undefined when file does not exist", async () => {
    const result = await loadReviewGuidelines();

    expect(result).toBeUndefined();
  });

  it("returns undefined when file is empty", async () => {
    await writeFile(guidelinesPath, "");

    const result = await loadReviewGuidelines();

    expect(result).toBeUndefined();
  });

  it("returns undefined when file contains only whitespace", async () => {
    await writeFile(guidelinesPath, "   \n\n  ");

    const result = await loadReviewGuidelines();

    expect(result).toBeUndefined();
  });

  it("trims whitespace from content", async () => {
    await writeFile(guidelinesPath, "\n  Some guidelines\n\n");

    const result = await loadReviewGuidelines();

    expect(result).toBe("Some guidelines");
  });
});
