import { describe, expect, it } from "bun:test";
import { buildFindingTextSection } from "../../../../src/core/review/prompts/finding-text";

describe("buildFindingTextSection", () => {
  it("asks for prose findings and an optional fix outline", () => {
    const block = buildFindingTextSection(false);
    expect(block).toStartWith("<finding_text>");
    expect(block).toContain("Put the direct claim first");
    expect(block).toContain("smallest view that makes the fix clear");
    expect(block).toContain('"Estimated fix: ~N lines".');
    expect(block).toContain("a wrong outline costs more than none");
    expect(block).toContain("under 30 seconds");
  });

  it("mentions suggestion blocks only when suggestions are on", () => {
    expect(buildFindingTextSection(true)).toContain(
      "other than a `suggestion` block",
    );
    expect(buildFindingTextSection(true)).toContain(
      "When a `suggestion` alone fixes the issue",
    );
    const off = buildFindingTextSection(false);
    expect(off).not.toContain("other than a `suggestion` block");
    expect(off).not.toContain("When a `suggestion` alone fixes the issue");
  });
});
