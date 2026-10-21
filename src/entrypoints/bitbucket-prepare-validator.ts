#!/usr/bin/env bun

/**
 * Between the two `droid exec` passes: overwrite the prompt file with the
 * Pass-2 (validator) prompt. Makes no Bitbucket API calls.
 */

import * as fs from "fs/promises";
import { generateBitbucketValidatorPrompt } from "../bitbucket/prompts";
import { readState, writeState } from "../bitbucket/state";

function ensure<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) {
    throw new Error(
      `bitbucket-prepare-validator: missing state.${name}; did bitbucket-prepare succeed?`,
    );
  }
  return value;
}

export async function run(): Promise<void> {
  const state = await readState();
  if (!state) {
    throw new Error(
      "bitbucket-prepare-validator: no state file; did bitbucket-prepare run?",
    );
  }
  if (!state.shouldRunReview) {
    console.log(
      `Review was skipped (${state.reason ?? "unknown"}); nothing to validate.`,
    );
    return;
  }

  const promptPath = ensure(state.promptPath, "promptPath");
  const candidatesPath = ensure(state.candidatesPath, "candidatesPath");

  try {
    const parsed = JSON.parse(await fs.readFile(candidatesPath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.comments)
    ) {
      throw new Error("missing or invalid `comments` array");
    }
    console.log(
      `Pass 1 produced ${parsed.comments.length} candidate comments.`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Pass 1 candidates JSON is invalid or missing: ${message}`);
    console.error("Skipping Pass 2 (validator).");
    await fs.writeFile(
      promptPath,
      "No review findings to validate. Pass 1 candidates were invalid. Exit with success.",
    );
    await writeState({ ...state, validatorSkippedReason: message });
    return;
  }

  const prompt = generateBitbucketValidatorPrompt({
    repoFullName: ensure(state.repoFullName, "repoFullName"),
    prId: ensure(state.prId, "prId"),
    sourceBranch: state.sourceBranch ?? "",
    targetBranch: state.targetBranch ?? "",
    headSha: state.headSha ?? "",
    diffPath: ensure(state.diffPath, "diffPath"),
    commentsPath: ensure(state.commentsPath, "commentsPath"),
    descriptionPath: ensure(state.descriptionPath, "descriptionPath"),
    candidatesPath,
    validatedPath: ensure(state.validatedPath, "validatedPath"),
    includeSuggestions: state.includeSuggestions,
    securityReviewEnabled: state.securityReviewEnabled,
    diffTruncated: state.diffTruncated === true,
  });
  await fs.writeFile(promptPath, prompt);
  console.log(`Wrote Pass-2 validator prompt to ${promptPath}`);
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(
      "bitbucket-prepare-validator failed:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
}
