import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import {
  parseDroidCommand,
  withoutMarkdownCode,
} from "../../src/core/review/triggers/parse-command";
import { checkContainsTrigger } from "../../src/github/validation/trigger";
import { extractCommandFromContext } from "../../src/github/utils/command-parser";
import { appTokenPermissionsFor } from "../../src/github/token-permissions";
import { prepareTagExecution, shouldTriggerTag } from "../../src/tag";
import * as actors from "../../src/github/validation/actor";
import * as lifecycle from "../../src/github/operations/review-lifecycle";
import { createMockContext } from "../mockContext";
import type { Octokits } from "../../src/github/api/client";

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
const context = (body: string) =>
  createMockContext({
    eventName: "issue_comment",
    isPR: true,
    payload: { comment: { body, id: 1 } } as any,
  });

describe("command Markdown and whitespace safety", () => {
  test.each([
    "    @droid pause",
    "\t@droid resolve",
    "`example\n@droid resolve\nend`",
    "``example\n@droid pause\nend``",
  ])(
    "does not trigger or mutate controls from a code example: %s",
    async (body) => {
      const paused = spyOn(lifecycle, "setReviewPaused").mockResolvedValue();
      const resolved = spyOn(
        lifecycle,
        "resolveAllDroidThreads",
      ).mockResolvedValue(1);
      spies.push(
        paused,
        resolved,
        spyOn(actors, "checkHumanActor").mockResolvedValue(),
        spyOn(core, "setOutput").mockImplementation(() => {}),
      );
      const ctx = context(body);
      const client = {
        rest: { issues: { createComment: async () => ({ data: {} }) } },
      } as unknown as Octokits;
      if (shouldTriggerTag(ctx))
        await prepareTagExecution({
          context: ctx,
          octokit: client,
          githubToken: "unused",
        });
      expect(paused).not.toHaveBeenCalled();
      expect(resolved).not.toHaveBeenCalled();
      expect(parseDroidCommand(body)).toBeNull();
      expect(extractCommandFromContext(ctx)).toBeNull();
      expect(checkContainsTrigger(ctx)).toBe(false);
      expect(appTokenPermissionsFor(ctx).contents).toBe("read");
      expect(withoutMarkdownCode(body).length).toBe(body.length);
    },
  );
  test("dispatches a real command following a multiline code example", async () => {
    const paused = spyOn(lifecycle, "setReviewPaused").mockResolvedValue();
    spies.push(
      paused,
      spyOn(lifecycle, "resolveAllDroidThreads").mockResolvedValue(1),
      spyOn(actors, "checkHumanActor").mockResolvedValue(),
      spyOn(core, "setOutput").mockImplementation(() => {}),
    );
    const body = "`example\n@droid resolve\nend`\n\n@droid pause";
    const client = {
      rest: { issues: { createComment: async () => ({ data: {} }) } },
    } as unknown as Octokits;
    await prepareTagExecution({
      context: context(body),
      octokit: client,
      githubToken: "unused",
    });
    expect(paused).toHaveBeenCalledTimes(1);
    expect(paused.mock.calls[0]?.[0].paused).toBe(true);
  });
  test.each([
    "`src/auth.ts`",
    "the `acquireLock` function",
    "`--full`",
    "`@droid pause`",
  ])("preserves quoted focus without executing it: %s", (focus) => {
    expect(parseDroidCommand(`@droid review ${focus}`)).toMatchObject({
      command: "review",
      focus,
    });
    expect(
      parseDroidCommand(`@droid review ${focus}`)?.fullReview,
    ).toBeUndefined();
  });
  test("only the unquoted full override is active", () => {
    expect(
      parseDroidCommand("@droid review --full `src/auth.ts`"),
    ).toMatchObject({
      command: "review",
      fullReview: true,
      focus: "`src/auth.ts`",
    });
    expect(
      parseDroidCommand("`@droid pause`\n@droid review `--full`"),
    ).toMatchObject({ command: "review", focus: "`--full`" });
  });
  test.each([
    ["@droid\nfill", "fill"],
    ["@droid security\n--full", "security-full"],
    ["@droid\nreview\n--full src/auth.ts", "review"],
  ])("preserves newline command tokens: %s", (body, command) => {
    expect(String(extractCommandFromContext(context(body))?.command)).toBe(
      command,
    );
  });
  test("preserves the complete newline-separated question for thread adapters", () => {
    expect(
      parseDroidCommand(
        "@droid\nWhy is this unsafe?\nWhat protects this path?",
      ),
    ).toMatchObject({
      command: "unknown",
      text: "Why is this unsafe?\nWhat protects this path?",
    });
  });
});
