import { describe, expect, test } from "bun:test";
import { parseReviewSkillTag } from "../../src/core/review/prompts/guidelines";
import { parseDroidCommand } from "../../src/core/review/triggers/parse-command";

describe("review skill tags", () => {
  test.each([
    ["/deletion-first-review", "deletion-first-review"],
    [" /deep-review ", "deep-review"],
    ["/a1", "a1"],
  ])("%s names %s", (focus, name) =>
    expect(parseReviewSkillTag(focus)).toBe(name),
  );

  // Anything that is not one plain directory name stays focus text.
  test.each([
    undefined,
    "",
    "deep-review",
    "/",
    "/Deep-Review",
    "/../secrets",
    "/a/b",
    "/a.b",
    "/-lead",
    "/deep-review please",
    `/${"a".repeat(65)}`,
  ])("%p is not a tag", (focus) =>
    expect(parseReviewSkillTag(focus)).toBeUndefined(),
  );

  test("the comment grammar hands the tag through as focus", () => {
    expect(
      parseDroidCommand("@droid review --full /deletion-first-review"),
    ).toMatchObject({
      command: "review",
      fullReview: true,
      focus: "/deletion-first-review",
    });
  });
});
