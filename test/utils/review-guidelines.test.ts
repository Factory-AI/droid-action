import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  loadReviewGuidelines,
  formatGuidelinesSection,
  MAX_GUIDELINES_SIZE,
} from "../../src/utils/review-guidelines";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";

describe("loadReviewGuidelines", () => {
  const testDir = join(process.cwd(), "__test_workspace__");
  const skillDir = join(testDir, ".factory", "skills", "review-guidelines");
  const guidelinesPath = join(skillDir, "SKILL.md");
  let originalWorkspace: string | undefined;

  beforeEach(async () => {
    originalWorkspace = process.env.GITHUB_WORKSPACE;
    process.env.GITHUB_WORKSPACE = testDir;
    await mkdir(skillDir, { recursive: true });
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

  it("truncates content exceeding MAX_GUIDELINES_SIZE", async () => {
    const largeContent = "x".repeat(MAX_GUIDELINES_SIZE + 1000);
    await writeFile(guidelinesPath, largeContent);

    const result = await loadReviewGuidelines();

    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(MAX_GUIDELINES_SIZE);
    expect(result).toContain("[truncated");
    expect(result).toContain(`${MAX_GUIDELINES_SIZE} character limit`);
    expect(result).toContain("Use your tools to read the full file");
  });

  it("does not truncate content at exactly MAX_GUIDELINES_SIZE", async () => {
    const exactContent = "y".repeat(MAX_GUIDELINES_SIZE);
    await writeFile(guidelinesPath, exactContent);

    const result = await loadReviewGuidelines();

    expect(result).toBe(exactContent);
    expect(result).not.toContain("[truncated");
  });
});

describe("formatGuidelinesSection", () => {
  it("returns empty string when guidelines is undefined", () => {
    expect(formatGuidelinesSection(undefined)).toBe("");
  });

  it("wraps guidelines in custom_review_guidelines tags", () => {
    const result = formatGuidelinesSection("- Check errors");

    expect(result).toContain("<custom_review_guidelines>");
    expect(result).toContain("</custom_review_guidelines>");
    expect(result).toContain("- Check errors");
  });

  it("references the correct skill path", () => {
    const result = formatGuidelinesSection("test");

    expect(result).toContain(".factory/skills/review-guidelines/SKILL.md");
  });
});
