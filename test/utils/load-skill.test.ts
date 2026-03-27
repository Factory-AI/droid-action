import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import * as fsPromises from "fs/promises";
import {
  extractSharedMethodology,
  formatSkillSection,
  loadSkill,
} from "../../src/utils/load-skill";

describe("extractSharedMethodology", () => {
  it("extracts content between markers", () => {
    const content = `
# Skill Header

Some intro text.

<!-- BEGIN_SHARED_METHODOLOGY -->
## Bug Patterns
- Pattern 1
- Pattern 2

## Reporting Gate
Only report real bugs.
<!-- END_SHARED_METHODOLOGY -->

## Other Section
This should not be included.
`;
    const result = extractSharedMethodology(content);
    expect(result).toContain("## Bug Patterns");
    expect(result).toContain("## Reporting Gate");
    expect(result).not.toContain("# Skill Header");
    expect(result).not.toContain("## Other Section");
  });

  it("returns full content when markers are missing", () => {
    const content = "No markers here, just plain content.";
    const result = extractSharedMethodology(content);
    expect(result).toBe(content);
  });

  it("returns full content when only BEGIN marker exists", () => {
    const content = "<!-- BEGIN_SHARED_METHODOLOGY -->\nSome content";
    const result = extractSharedMethodology(content);
    expect(result).toBe(content);
  });

  it("returns full content when END comes before BEGIN", () => {
    const content =
      "<!-- END_SHARED_METHODOLOGY -->\nMiddle\n<!-- BEGIN_SHARED_METHODOLOGY -->";
    const result = extractSharedMethodology(content);
    expect(result).toBe(content);
  });
});

describe("formatSkillSection", () => {
  it("returns empty string for undefined input", () => {
    expect(formatSkillSection(undefined)).toBe("");
  });

  it("returns empty string for empty string input", () => {
    expect(formatSkillSection("")).toBe("");
  });

  it("wraps extracted methodology in XML tags", () => {
    const content = `
<!-- BEGIN_SHARED_METHODOLOGY -->
## Reporting Gate
Only report real bugs.
<!-- END_SHARED_METHODOLOGY -->
`;
    const result = formatSkillSection(content);
    expect(result).toContain("<code_review_methodology>");
    expect(result).toContain("</code_review_methodology>");
    expect(result).toContain("## Reporting Gate");
  });
});

describe("loadSkill", () => {
  let readdirSpy: ReturnType<typeof spyOn>;
  let readFileSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = "/mock-home";
    readdirSpy = spyOn(fsPromises, "readdir");
    readFileSpy = spyOn(fsPromises, "readFile");
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    readdirSpy.mockRestore();
    readFileSpy.mockRestore();
    fetchSpy.mockRestore();
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  });

  it("loads skill from local cache when available", async () => {
    readdirSpy.mockResolvedValue(["abc123"] as any);
    readFileSpy.mockResolvedValue("cached skill content");

    const result = await loadSkill("review");

    expect(result).toBe("cached skill content");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to GitHub when local cache is empty", async () => {
    readdirSpy.mockRejectedValue(new Error("ENOENT"));
    fetchSpy.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("github skill content"),
    } as Response);

    const result = await loadSkill("review");

    expect(result).toBe("github skill content");
    const fetchUrl = fetchSpy.mock.calls[0]![0] as string;
    expect(fetchUrl).toContain("Factory-AI/factory-mono");
    expect(fetchUrl).toContain("ref=feat");
    expect(fetchUrl).toContain("builtin-skills/review/SKILL.md");
  });

  it("throws when both sources fail", async () => {
    readdirSpy.mockRejectedValue(new Error("ENOENT"));
    fetchSpy.mockResolvedValue({ ok: false, status: 404 } as Response);

    await expect(loadSkill("review")).rejects.toThrow(
      'Required skill "review" not found',
    );
  });

  it("skips empty cache entries and tries next hash", async () => {
    readdirSpy.mockResolvedValue(["hash1", "hash2"] as any);
    readFileSpy
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce("skill from hash2");

    const result = await loadSkill("review");
    expect(result).toBe("skill from hash2");
  });
});
