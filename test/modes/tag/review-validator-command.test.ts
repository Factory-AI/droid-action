import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("review-validator command model handling", () => {
  it("reads REVIEW_MODEL and REASONING_EFFORT from env", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "tag", "commands", "review-validator.ts"),
      "utf8",
    );

    expect(source).toContain(
      "const reviewModel = process.env.REVIEW_MODEL?.trim();",
    );
    expect(source).toContain(
      "const reasoningEffort = process.env.REASONING_EFFORT?.trim();",
    );
  });

  it("adds --model and --reasoning-effort conditionally", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "tag", "commands", "review-validator.ts"),
      "utf8",
    );

    expect(source).toContain('droidArgParts.push(`--model "${reviewModel}"`)');
    expect(source).toContain(
      'droidArgParts.push(`--reasoning-effort "${reasoningEffort}"`)',
    );
  });
});
