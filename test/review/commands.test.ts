import { describe, expect, test } from "bun:test";
import { parseDroidCommand } from "../../src/core/review/triggers/parse-command";
import { checkContainsTrigger } from "../../src/github/validation/trigger";
import { extractCommandFromContext } from "../../src/github/utils/command-parser";
import { appTokenPermissionsFor } from "../../src/github/token-permissions";
import { createMockContext } from "../mockContext";

describe("review UX command grammar", () => {
  test.each([
    ["@droid", "default"],
    ["@droid!", "default"],
    ["@DROID: HELP!", "help"],
    ["@droid review", "review"],
    ["@droid review --full", "review"],
    ["@DROID: REVIEW --FULL.", "review"],
    ["@droid review the migration for locking issues", "review"],
    ["@droid security", "security"],
    ["@droid review security", "security"],
    ["@DROID REVIEW SECURITY --FULL", "security-full"],
    ["@droid security --full", "security-full"],
    ["@DROID, SECURITY --FULL!", "security-full"],
    ["@droid fix", "unknown"],
    ["@droid resolve.", "resolve"],
    ["@droid pause", "pause"],
    ["@droid resume", "resume"],
    ["@droid remember this", "unknown"],
    ["@droid reviewer", "unknown"],
  ])("%s routes to %s", (text, command) =>
    expect(String(parseDroidCommand(text)?.command)).toBe(command),
  );

  test("preserves focus independently of full override", () => {
    expect(
      parseDroidCommand("@droid review --full the migration"),
    ).toMatchObject({
      command: "review",
      fullReview: true,
      focus: "the migration",
    });
    expect(parseDroidCommand("@droid review security --full")).toMatchObject({
      command: "security-full",
    });
  });
  test.each([
    "```\n@droid fix\n```",
    "~~~text\n@droid review\n~~~",
    "`@droid review`",
    "````md\n```\n@droid fix\n```\n````",
    "user@droid.com",
    "@droid-bot review",
  ])("ignores code and lookalikes: %s", (text) =>
    expect(parseDroidCommand(text)).toBeNull(),
  );
  test("finds real command after fenced sample", () => {
    expect(
      parseDroidCommand("```md\n@droid fix\n```\n@droid help")?.command,
    ).toBe("help");
  });
  test("fenced trigger is ignored all the way through trigger and permission narrowing", () => {
    const context = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      payload: { comment: { body: "```\n@droid fix\n```" } } as any,
    });
    expect(checkContainsTrigger(context)).toBe(false);
    expect(appTokenPermissionsFor(context).contents).toBe("read");
  });
  test("PR prose cannot authorize state changes; controls keep read-only contents access", () => {
    const context = createMockContext({
      eventName: "pull_request",
      isPR: true,
      payload: { pull_request: { body: "@droid pause" } } as any,
    });
    expect(extractCommandFromContext(context)?.command).toBe("unknown");
    expect(appTokenPermissionsFor(context).contents).toBe("read");
    const comment = createMockContext({
      eventName: "issue_comment",
      isPR: true,
      inputs: { ...context.inputs, automaticReview: true },
      payload: { comment: { body: "@droid pause" } } as any,
    });
    expect(appTokenPermissionsFor(comment).contents).toBe("read");
  });
});
