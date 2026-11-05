import { describe, expect, it } from "bun:test";
import {
  INLINE_GUIDELINES_MAX_BYTES,
  buildRepoGuidelinesSection,
  stripSkillFrontmatter,
} from "../../../../src/core/review/prompts/guidelines";

const guidelines = {
  source: ".factory/skills/review-guidelines/SKILL.md@main",
  body: "# Review guidelines\n\n- Keep PRs under 300 lines.",
  path: "/tmp/droid-prompts/review_guidelines.md",
};

describe("stripSkillFrontmatter", () => {
  it("removes the leading YAML block and surrounding whitespace", () => {
    expect(
      stripSkillFrontmatter(
        "---\nname: review-guidelines\ndescription: Repo rules\n---\n\n# Rules\n- one\n",
      ),
    ).toBe("# Rules\n- one");
  });

  it("handles CRLF line endings", () => {
    expect(stripSkillFrontmatter("---\r\nname: x\r\n---\r\n# Rules\r\n")).toBe(
      "# Rules",
    );
  });

  it("leaves text without frontmatter alone", () => {
    expect(stripSkillFrontmatter("# Rules\n\n---\n\nmore")).toBe(
      "# Rules\n\n---\n\nmore",
    );
  });
});

describe("buildRepoGuidelinesSection", () => {
  it("returns nothing when the repository has no guidelines", () => {
    expect(buildRepoGuidelinesSection(undefined, "candidates")).toBeUndefined();
  });

  it("inlines the guidelines and tells Pass 1 to forward them to subagents", () => {
    const section = buildRepoGuidelinesSection(guidelines, "candidates")!;

    expect(section).toContain(
      `<review-guidelines source="${guidelines.source}">\n${guidelines.body}\n</review-guidelines>`,
    );
    expect(section).toContain("do not invoke the `review-guidelines` skill");
    expect(section).toContain(
      "copy the `<review-guidelines>` block below verbatim",
    );
    expect(section).not.toContain(guidelines.path);
  });

  it("does not mention subagents to the validator", () => {
    const section = buildRepoGuidelinesSection(guidelines, "validator")!;

    expect(section).toContain(guidelines.body);
    expect(section).toContain("judging each candidate");
    expect(section).not.toContain("subagent");
  });

  it("points at the on-disk copy instead of inlining oversized guidelines", () => {
    const body = "x".repeat(INLINE_GUIDELINES_MAX_BYTES + 1);
    const section = buildRepoGuidelinesSection(
      { ...guidelines, body },
      "candidates",
    )!;

    expect(section).not.toContain(body);
    expect(section).toContain(`stored at \`${guidelines.path}\``);
    expect(section).toContain("Read that file in full before you start");
    expect(section).toContain("instruct each one to read that file in full");
  });

  it("measures the inline limit in bytes, not characters", () => {
    // Each of these is one character but three bytes.
    const body = "€".repeat(INLINE_GUIDELINES_MAX_BYTES / 3 + 1);
    const section = buildRepoGuidelinesSection(
      { ...guidelines, body },
      "validator",
    )!;

    expect(section).not.toContain(body);
    expect(section).toContain(guidelines.path);
  });

  it.each(["candidates", "validator"] as const)(
    "keeps the exact 32 KiB UTF-8 boundary in the %s pass",
    (pass) => {
      const exact = "€".repeat(Math.floor(32_768 / 3)) + "xx";
      expect(Buffer.byteLength(exact, "utf8")).toBe(32_768);
      expect(
        buildRepoGuidelinesSection({ ...guidelines, body: exact }, pass),
      ).toContain(exact);
      const oversized = exact + "x";
      const fallback = buildRepoGuidelinesSection(
        { ...guidelines, body: oversized },
        pass,
      );
      expect(fallback).not.toContain(oversized);
      expect(fallback).toContain(guidelines.path);
    },
  );
});
