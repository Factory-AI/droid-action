#!/usr/bin/env bun

/**
 * Prepare step for Pass 2 (validator) of the GitLab two-pass review flow.
 *
 * Runs between the two `droid exec` invocations in the CI template:
 *
 *   1. Reads the state file produced by `gitlab-prepare.ts` (Pass 1).
 *      Bails out cleanly if Pass 1 decided not to review.
 *   2. Reconstructs the GitLab review prompt context from state.
 *   3. Generates the Pass-2 validator prompt.
 *   4. Overwrites the shared prompt file (the same file Pass 1 used)
 *      so the next `droid exec -f <promptPath>` consumes Pass 2.
 *
 * No GitLab API calls are made here — all the data we need is already
 * on disk from Pass 1's artifact precomputation.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { generateGitlabReviewValidatorPrompt } from "../gitlab/prompts/validator";
import type { GitlabReviewPromptContext } from "../gitlab/prompts/types";
import { stateFilePath, type PrepareState } from "./gitlab-prepare";

async function readState(): Promise<PrepareState> {
  const filePath = stateFilePath();
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw) as PrepareState;
}

async function writeState(state: PrepareState): Promise<void> {
  const filePath = stateFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
}

function ensure<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) {
    throw new Error(
      `gitlab-prepare-validator: missing state.${name}; was gitlab-prepare run successfully?`,
    );
  }
  return value;
}

async function run(): Promise<void> {
  const state = await readState();

  if (!state.shouldRunReview) {
    console.log(
      `Pass 1 was skipped (reason: ${state.reason ?? "unknown"}); skipping validator prepare.`,
    );
    return;
  }

  const promptPath = ensure(state.promptPath, "promptPath");
  const mrIid = ensure(state.mrIid, "mrIid");
  const candidatesPath = ensure(state.candidatesPath, "candidatesPath");
  const validatedPath = ensure(state.validatedPath, "validatedPath");
  const diffPath = ensure(state.diffPath, "diffPath");
  const commentsPath = ensure(state.commentsPath, "commentsPath");
  const descriptionPath = ensure(state.descriptionPath, "descriptionPath");
  const headSha = ensure(state.headSha, "headSha");

  // Validate that Pass 1 produced a valid candidates JSON file.
  // If invalid or missing, skip Pass 2 gracefully rather than failing.
  try {
    const content = await fs.readFile(candidatesPath, "utf8");
    const parsed = JSON.parse(content);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.comments)
    ) {
      throw new Error("Missing or invalid 'comments' array in candidates");
    }
    console.log(
      `Pass 1 candidates validated: ${parsed.comments.length} comments found`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Pass 1 candidates JSON is invalid or missing: ${message}`);
    console.error(
      "Skipping Pass 2 (validator) to avoid a full pipeline failure",
    );
    // Write a no-op prompt so droid exec exits cleanly
    await fs.writeFile(
      promptPath,
      "No review findings to validate. Pass 1 candidates were invalid. Exit with success.",
    );
    // Pass 2 will not write the validated file, and the posting step treats a
    // missing one as a failure. Record the short circuit so it can no-op
    // instead of turning this soft landing into a red pipeline.
    await writeState({ ...state, validatorSkippedReason: message });
    return;
  }

  const promptCtx: GitlabReviewPromptContext = {
    projectPath: state.projectPath,
    mrIid,
    mrTitle: state.mrTitle ?? "",
    sourceBranch: state.sourceBranch ?? "",
    targetBranch: state.targetBranch ?? "",
    headSha,
    diffPath,
    commentsPath,
    descriptionPath,
    candidatesPath,
    validatedPath,
    includeSuggestions: state.includeSuggestions,
    securityReviewEnabled: state.securityReviewEnabled,
  };

  const prompt = generateGitlabReviewValidatorPrompt(promptCtx);
  await fs.mkdir(path.dirname(promptPath), { recursive: true });
  await fs.writeFile(promptPath, prompt);
  console.log(
    `Wrote Pass-2 validator prompt (${prompt.length} bytes) to ${promptPath} (overwrote Pass 1)`,
  );
}

if (import.meta.main) {
  run().catch((error) => {
    console.error("gitlab-prepare-validator failed:", error);
    process.exit(1);
  });
}

export { run };
