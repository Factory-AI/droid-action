import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { PullRequestEvent } from "@octokit/webhooks-types";
import {
  shouldTriggerCustomAutomation,
  prepareCustomAutomationMode,
} from "../src/custom-automation";
import { shouldTriggerTag } from "../src/tag";
import { createMockContext, createMockAutomationContext } from "./mockContext";
import type { Octokits } from "../src/github/api/client";

const PROMPT = "Find duplicated code and open a PR consolidating it.";

// Minimal PR payload so checkContainsTrigger can inspect body/title.
const PR_PAYLOAD = {
  pull_request: { body: "A regular PR body", title: "A regular PR title" },
} as PullRequestEvent;

describe("shouldTriggerCustomAutomation", () => {
  it("triggers on automation events when a prompt is set", () => {
    const context = createMockAutomationContext({
      eventName: "schedule",
      inputs: { prompt: PROMPT },
    });
    expect(shouldTriggerCustomAutomation(context)).toBe(true);
  });

  it("triggers on workflow_dispatch when a prompt is set", () => {
    const context = createMockAutomationContext({
      eventName: "workflow_dispatch",
      inputs: { prompt: PROMPT },
    });
    expect(shouldTriggerCustomAutomation(context)).toBe(true);
  });

  it("does not trigger when the prompt is empty or whitespace", () => {
    expect(
      shouldTriggerCustomAutomation(
        createMockAutomationContext({ eventName: "schedule" }),
      ),
    ).toBe(false);
    expect(
      shouldTriggerCustomAutomation(
        createMockAutomationContext({
          eventName: "schedule",
          inputs: { prompt: "   " },
        }),
      ),
    ).toBe(false);
  });

  it("triggers on entity events with a prompt and no @droid command", () => {
    const context = createMockContext({
      eventName: "pull_request",
      isPR: true,
      payload: PR_PAYLOAD,
      inputs: { prompt: PROMPT },
    });
    expect(shouldTriggerCustomAutomation(context)).toBe(true);
    // The tag flow must not claim this event, so dispatch precedence sends it
    // to the custom automation mode.
    expect(shouldTriggerTag(context)).toBe(false);
  });

  it("cedes precedence to the automatic review flow on PR events", () => {
    const context = createMockContext({
      eventName: "pull_request",
      isPR: true,
      inputs: { prompt: PROMPT, automaticReview: true },
    });
    // Both would trigger, but prepare() dispatches shouldTriggerTag first.
    expect(shouldTriggerTag(context)).toBe(true);
    expect(shouldTriggerCustomAutomation(context)).toBe(true);
  });
});

describe("prepareCustomAutomationMode", () => {
  let tempDir: string;
  const originalRunnerTemp = process.env.RUNNER_TEMP;
  const originalDroidArgs = process.env.DROID_ARGS;
  const originalGithubOutput = process.env.GITHUB_OUTPUT;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "custom-automation-test-"));
    process.env.RUNNER_TEMP = tempDir;
    // Route @actions/core setOutput/exportVariable writes into temp files so
    // the test never touches a real Actions environment. @actions/core
    // requires the command files to already exist.
    process.env.GITHUB_OUTPUT = join(tempDir, "github-output");
    process.env.GITHUB_ENV = join(tempDir, "github-env");
    writeFileSync(process.env.GITHUB_OUTPUT, "");
    writeFileSync(process.env.GITHUB_ENV, "");
    delete process.env.DROID_ARGS;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env.RUNNER_TEMP = originalRunnerTemp;
    process.env.DROID_ARGS = originalDroidArgs;
    process.env.GITHUB_OUTPUT = originalGithubOutput;
  });

  it("writes the prompt file with the user task and environment preamble", async () => {
    const context = createMockAutomationContext({
      eventName: "schedule",
      inputs: { prompt: PROMPT },
    });

    const result = await prepareCustomAutomationMode({
      context,
      octokit: {} as Octokits,
      githubToken: "token",
    });

    const promptFile = readFileSync(
      join(tempDir, "droid-prompts", "droid-prompt.txt"),
      "utf8",
    );
    expect(promptFile).toContain(PROMPT);
    expect(promptFile).toContain("test-owner/test-repo");
    expect(promptFile).toContain("`schedule` event");
    expect(promptFile).toContain("open a pull request");
    expect(result.mcpTools).toBe("");
  });

  it("passes user droid_args through to the exec step", async () => {
    process.env.DROID_ARGS = "-m claude-fable-5";
    const context = createMockAutomationContext({
      eventName: "workflow_dispatch",
      inputs: { prompt: PROMPT },
    });

    await prepareCustomAutomationMode({
      context,
      octokit: {} as Octokits,
      githubToken: "token",
    });

    const output = readFileSync(join(tempDir, "github-output"), "utf8");
    expect(output).toContain("droid_args");
    expect(output).toContain("-m claude-fable-5");
  });

  it("describes the triggering entity for entity events", async () => {
    const octokit = {
      rest: {
        users: {
          getByUsername: async () => ({ data: { type: "User" } }),
        },
      },
    } as unknown as Octokits;
    const context = createMockContext({
      eventName: "pull_request",
      isPR: true,
      entityNumber: 42,
      inputs: { prompt: PROMPT },
    });

    await prepareCustomAutomationMode({
      context,
      octokit,
      githubToken: "token",
    });

    const promptFile = readFileSync(
      join(tempDir, "droid-prompts", "droid-prompt.txt"),
      "utf8",
    );
    expect(promptFile).toContain("pull request #42");
  });

  it("rejects bot actors on entity events unless allow-listed", async () => {
    const octokit = {
      rest: {
        users: {
          getByUsername: async () => ({ data: { type: "Bot" } }),
        },
      },
    } as unknown as Octokits;
    const context = createMockContext({
      eventName: "pull_request",
      isPR: true,
      actor: "some-bot",
      inputs: { prompt: PROMPT },
    });

    await expect(
      prepareCustomAutomationMode({
        context,
        octokit,
        githubToken: "token",
      }),
    ).rejects.toThrow();
  });
});
