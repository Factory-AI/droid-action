import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { run as prepareValidator } from "../../src/entrypoints/gitlab-prepare-validator";

const ENV_KEYS = ["DROID_STATE_FILE", "DROID_PROMPT_FILE"] as const;

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

async function writeState(overrides: Record<string, unknown> = {}) {
  const statePath = path.join(tmpDir, ".droid-state.json");
  await fs.writeFile(
    statePath,
    JSON.stringify({
      shouldRunReview: true,
      projectId: "42",
      projectPath: "group/project",
      mrIid: 7,
      promptPath: path.join(tmpDir, "droid-prompt.txt"),
      candidatesPath: path.join(tmpDir, "review_candidates.json"),
      validatedPath: path.join(tmpDir, "review_validated.json"),
      diffPath: path.join(tmpDir, "mr.diff"),
      commentsPath: path.join(tmpDir, "existing_comments.json"),
      descriptionPath: path.join(tmpDir, "mr_description.txt"),
      headSha: "head-sha",
      includeSuggestions: true,
      securityReviewEnabled: false,
      ...overrides,
    }),
  );
  process.env.DROID_STATE_FILE = statePath;
  return statePath;
}

async function readState(statePath: string) {
  return JSON.parse(await fs.readFile(statePath, "utf8"));
}

async function readPrompt() {
  return fs.readFile(path.join(tmpDir, "droid-prompt.txt"), "utf8");
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "droid-prepare-validator-"));
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("gitlab-prepare-validator entrypoint", () => {
  it("overwrites the prompt with the Pass 2 validator prompt", async () => {
    const statePath = await writeState();
    await fs.writeFile(
      path.join(tmpDir, "review_candidates.json"),
      JSON.stringify({
        comments: [{ path: "a.ts", body: "[P1] Finding", line: 3 }],
      }),
    );

    await prepareValidator();

    const prompt = await readPrompt();
    expect(prompt).toContain("review_validated.json");
    expect(prompt.length).toBeGreaterThan(200);
    expect((await readState(statePath)).validatorSkippedReason).toBeUndefined();
  });

  it("records the short circuit in state when Pass 1 left no usable candidates", async () => {
    // The posting step treats a missing review_validated.json as a failure, so
    // this flag is what keeps the deliberate soft landing green.
    const statePath = await writeState();

    await prepareValidator();

    expect(await readPrompt()).toContain("Exit with success");
    const state = await readState(statePath);
    expect(state.validatorSkippedReason).toBeTruthy();
    // Everything else prepare recorded has to survive the rewrite.
    expect(state).toMatchObject({
      shouldRunReview: true,
      mrIid: 7,
      projectPath: "group/project",
      headSha: "head-sha",
      validatedPath: path.join(tmpDir, "review_validated.json"),
    });
  });

  it("records the short circuit when the candidates file is malformed", async () => {
    const statePath = await writeState();
    await fs.writeFile(
      path.join(tmpDir, "review_candidates.json"),
      '{"comments": "not an array"}',
    );

    await prepareValidator();

    expect((await readState(statePath)).validatorSkippedReason).toContain(
      "comments",
    );
  });

  it("does nothing when prepare decided not to review", async () => {
    const statePath = await writeState({
      shouldRunReview: false,
      reason: "not-merge-request-event",
    });

    await prepareValidator();

    await expect(readPrompt()).rejects.toThrow();
    expect((await readState(statePath)).validatorSkippedReason).toBeUndefined();
  });
});
