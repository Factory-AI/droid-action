#!/usr/bin/env bun

/**
 * Stages the review's prompts, pass logs and error file into
 * `<work dir>/.droid-debug` for the CI artifact, with every Bitbucket and
 * Factory credential redacted. The pass logs are raw stream-json, so they
 * include the output of any command Droid ran.
 *
 * Env: DROID_DEBUG_DIR (output directory), DROID_ERROR_FILE, plus the
 * prompt/state paths `bitbucket/droid-review.sh` exports.
 */

import {
  collectDebugArtifacts,
  type DebugArtifactSource,
} from "../utils/debug-artifacts";
import { promptsDir } from "../bitbucket/state";
import { bitbucketSecretValues } from "../bitbucket/token";

export function bitbucketDebugArtifactSources(
  prompts: string,
  errorFile: string | undefined,
): DebugArtifactSource[] {
  const sources: DebugArtifactSource[] = [{ from: prompts, to: "prompts" }];
  if (errorFile) sources.push({ from: errorFile, to: "droid-error.txt" });
  return sources;
}

export async function run(): Promise<void> {
  const outputDir = process.env.DROID_DEBUG_DIR;
  if (!outputDir) {
    throw new Error("DROID_DEBUG_DIR is not set");
  }
  const result = await collectDebugArtifacts({
    sources: bitbucketDebugArtifactSources(
      promptsDir(),
      process.env.DROID_ERROR_FILE,
    ),
    outputDir,
    secrets: bitbucketSecretValues(),
  });
  console.log(
    `Staged ${result.files} debug files with credentials redacted in ${outputDir}.`,
  );
  if (result.skipped.length > 0) {
    console.log(
      `Left out ${result.skipped.length} symlinks or credential files.`,
    );
  }
}

if (import.meta.main) {
  run().catch((error) => {
    console.error(
      `Could not stage debug artifacts, so none will be uploaded: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
