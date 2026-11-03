import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import {
  parseDroidCommand,
  withoutMarkdownCode,
} from "../../src/core/review/triggers/parse-command";
import { checkContainsTrigger } from "../../src/github/validation/trigger";
import { extractCommandFromContext } from "../../src/github/utils/command-parser";
import { prepareTagExecution, shouldTriggerTag } from "../../src/tag";
import * as actors from "../../src/github/validation/actor";
import * as lifecycle from "../../src/github/operations/review-lifecycle";
import { createMockContext } from "../mockContext";
import type { Octokits } from "../../src/github/api/client";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function observe(body: string) {
  const paused = spyOn(lifecycle, "setReviewPaused").mockResolvedValue();
  const resolved = spyOn(lifecycle, "resolveAllDroidThreads").mockResolvedValue(
    1,
  );
  spies.push(
    paused,
    resolved,
    spyOn(actors, "checkHumanActor").mockResolvedValue(),
    spyOn(core, "setOutput").mockImplementation(() => {}),
    spyOn(core, "exportVariable").mockImplementation(() => {}),
  );
  const context = createMockContext({
    eventName: "issue_comment",
    isPR: true,
    payload: { comment: { body, id: 1 } } as any,
  });
  const client = {
    rest: { issues: { createComment: async () => ({ data: {} }) } },
  } as unknown as Octokits;
  const triggered = shouldTriggerTag(context);
  if (triggered)
    await prepareTagExecution({
      context,
      octokit: client,
      githubToken: "unused",
    });
  const masked = withoutMarkdownCode(body);
  expect(masked.length).toBe(body.length);
  expect(masked.match(/[\r\n]/g)).toEqual(body.match(/[\r\n]/g));
  return {
    command: parseDroidCommand(body)?.command ?? null,
    extracted: extractCommandFromContext(context)?.command ?? null,
    containsTrigger: checkContainsTrigger(context),
    triggered,
    paused: paused.mock.calls.map((call) => call[0].paused),
    resolved: resolved.mock.calls.length,
  };
}

describe("inline code remains within its Markdown block", () => {
  test.each([
    [
      "blank paragraphs",
      "Unmatched literal ` here\n\n@droid resume\n\nAnother literal ` here",
    ],
    [
      "CRLF paragraphs",
      "Unmatched literal ` here\r\n \r\n@droid resume\r\n\r\nAnother literal ` here",
    ],
    [
      "new ATX heading",
      "Unmatched literal ` here\n# Heading\n@droid resume\nAnother literal ` here",
    ],
    [
      "heading ends before command",
      "# Unmatched literal ` here\n@droid resume\nAnother literal ` here",
    ],
    [
      "setext heading",
      "Unmatched literal ` here\n===\n@droid resume\nAnother literal ` here",
    ],
    [
      "thematic break",
      "Unmatched literal ` here\n* * *\n@droid resume\nAnother literal ` here",
    ],
    [
      "new quote",
      "Unmatched literal ` here\n> @droid resume\nAnother literal ` here",
    ],
    [
      "quoted blank paragraphs",
      "> Unmatched literal ` here\n>\n> @droid resume\n>\n> Another literal ` here",
    ],
    [
      "list items",
      "- Unmatched literal ` here\n- @droid resume\n- Another literal ` here",
    ],
    [
      "ordered list items",
      "2. Unmatched literal ` here\n3. @droid resume\n4. Another literal ` here",
    ],
    [
      "fenced block interrupt",
      "Unmatched literal ` here\n```text\nfixture\n```\n@droid resume\nAnother literal ` here",
    ],
    [
      "closed multiline example then visible command",
      "`example\n@droid resolve\nend`\n@droid resume",
    ],
  ])("dispatches the visible resume across %s", async (_label, body) => {
    expect(await observe(body)).toEqual({
      command: "resume",
      extracted: "resume",
      containsTrigger: true,
      triggered: true,
      paused: [false],
      resolved: 0,
    });
  });
  test.each([
    ["one soft newline", "`example\n@droid resume`"],
    ["two soft newlines", "`example\n@droid resume\nend`"],
    ["CRLF soft newlines", "`example\r\n@droid resume\r\nend`"],
    ["quoted soft newlines", "> `example\n> @droid resume\n> end`"],
    ["lazy quote continuation", "> `example\n@droid resume\nend`"],
    ["lazy list continuation", "- `example\n@droid resume\nend`"],
    [
      "ordered2 does not interrupt a paragraph",
      "`example\n2. @droid resume\nend`",
    ],
    [
      "indented paragraph continuation",
      "`example\n    continuation\n@droid resume\nend`",
    ],
  ])("never dispatches code with %s", async (_label, body) => {
    expect(await observe(body)).toEqual({
      command: null,
      extracted: null,
      containsTrigger: false,
      triggered: false,
      paused: [],
      resolved: 0,
    });
  });
});
