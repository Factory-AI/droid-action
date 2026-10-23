#!/usr/bin/env bun

/**
 * Prepares Pass 2 (validator) from the state `azure-devops-prepare` wrote,
 * overwriting the shared prompt file. No API calls.
 */

import * as fs from "fs/promises";
import { generateAzureDevopsValidatorPrompt } from "../azure-devops/prompts";
import { readState, writeState } from "../azure-devops/paths";

function ensure<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) {
    throw new Error(
      `azure-devops-prepare-validator: missing state.${name}; did azure-devops-prepare succeed?`,
    );
  }
  return value;
}

export async function run(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const state = await readState(env);
  if (!state) {
    throw new Error("azure-devops-prepare-validator: no state file");
  }
  if (!state.shouldRunReview) {
    console.log(
      `Review skipped (${state.reason ?? "unknown"}); nothing to do.`,
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
      throw new Error("Missing or invalid 'comments' array in candidates");
    }
    console.log(`Pass 1 produced ${parsed.comments.length} candidates`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Pass 1 candidates JSON is invalid or missing: ${message}`);
    await fs.writeFile(
      promptPath,
      "No review findings to validate. Pass 1 candidates were invalid. Exit with success.",
    );
    await writeState({ ...state, validatorSkippedReason: message }, env);
    return;
  }

  const prompt = generateAzureDevopsValidatorPrompt({
    repository: state.repository,
    pullRequestId: ensure(state.pullRequestId, "pullRequestId"),
    sourceBranch: state.sourceBranch ?? "",
    targetBranch: state.targetBranch ?? "",
    headSha: ensure(state.headSha, "headSha"),
    diffPath: ensure(state.diffPath, "diffPath"),
    commentsPath: ensure(state.commentsPath, "commentsPath"),
    descriptionPath: ensure(state.descriptionPath, "descriptionPath"),
    candidatesPath,
    validatedPath: ensure(state.validatedPath, "validatedPath"),
    includeSuggestions: state.includeSuggestions,
    securityReviewEnabled: state.securityReviewEnabled,
  });
  await fs.writeFile(promptPath, prompt);
  console.log(`Wrote Pass-2 validator prompt to ${promptPath}`);
}

if (import.meta.main) {
  run().catch((error) => {
    console.error("azure-devops-prepare-validator failed:", error);
    process.exit(1);
  });
}
