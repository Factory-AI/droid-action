#!/usr/bin/env bun

/**
 * Stages the review's prompts, pass logs and error file into
 * `$CI_PROJECT_DIR/.droid-debug` for the job artifact, with every credential
 * the job holds redacted. The pass logs are raw stream-json, so they include
 * the output of any command Droid ran.
 */

import path from "path";
import {
  collectDebugArtifacts,
  type DebugArtifactSource,
} from "../utils/debug-artifacts";
import {
  GITLAB_CREDENTIAL_ENV_NAMES,
  secretValuesFromEnv,
} from "../utils/redact-credentials";
import { promptsDir } from "./gitlab-prepare";

export function gitlabDebugArtifactSources(
  prompts: string,
): DebugArtifactSource[] {
  return [
    { from: prompts, to: "prompts" },
    { from: "/tmp/droid-error.txt", to: "droid-error.txt" },
  ];
}

export async function run(): Promise<void> {
  const outputDir = path.join(
    process.env.CI_PROJECT_DIR || process.cwd(),
    ".droid-debug",
  );

  try {
    const result = await collectDebugArtifacts({
      sources: gitlabDebugArtifactSources(promptsDir()),
      outputDir,
      secrets: secretValuesFromEnv(GITLAB_CREDENTIAL_ENV_NAMES),
    });
    console.log(
      `Staged ${result.files} debug files with credentials redacted in ${outputDir}.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Could not stage debug artifacts, so none will be uploaded: ${message}`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
