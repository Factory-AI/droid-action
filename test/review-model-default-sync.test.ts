import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function extractReviewModelDefault(yaml: string): string {
  const match = yaml.match(
    /review_model:\n(?:\s+.*\n)*?\s+default:\s*"([^"]+)"/,
  );

  expect(match).toBeTruthy();
  return match?.[1] ?? "";
}

describe("review_model default sync", () => {
  it("keeps review_model default in sync between action manifests", () => {
    const rootActionYaml = readFileSync(
      join(process.cwd(), "action.yml"),
      "utf8",
    );
    const reviewActionYaml = readFileSync(
      join(process.cwd(), "review", "action.yml"),
      "utf8",
    );

    const rootDefault = extractReviewModelDefault(rootActionYaml);
    const reviewDefault = extractReviewModelDefault(reviewActionYaml);

    expect(rootDefault).toBe(reviewDefault);
    expect(rootDefault.length).toBeGreaterThan(0);
  });
});
