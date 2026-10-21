#!/usr/bin/env bun

/**
 * Stages the prompts directory (prompts, pass logs, candidate and validated
 * JSON, the error file) into the directory the pipeline publishes as the
 * `droid-debug-<attempt>` build artifact, with every credential the job
 * holds redacted. The pass logs are raw stream-json, so they include the
 * output of any command Droid ran.
 *
 * Env: DROID_DEBUG_DIR (output, default $AGENT_TEMPDIRECTORY/droid-debug)
 * and the prompt path vars read by `promptsDir`.
 */

import * as path from "path";
import { collectDebugArtifacts } from "../utils/debug-artifacts";
import {
  AZURE_DEVOPS_CREDENTIAL_ENV_NAMES,
  secretValuesFromEnv,
} from "../utils/redact-credentials";
import { promptsDir } from "../azure-devops/paths";

export function debugArtifactsDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    env.DROID_DEBUG_DIR ||
    path.join(env.AGENT_TEMPDIRECTORY || env.TMPDIR || "/tmp", "droid-debug")
  );
}

export async function run(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ files: number; skipped: string[] }> {
  const outputDir = debugArtifactsDir(env);
  const result = await collectDebugArtifacts({
    sources: [{ from: promptsDir(env), to: "." }],
    outputDir,
    secrets: secretValuesFromEnv(AZURE_DEVOPS_CREDENTIAL_ENV_NAMES, env),
  });
  console.log(
    `Staged ${result.files} debug files with credentials redacted in ${outputDir}.`,
  );
  return result;
}

if (import.meta.main) {
  run().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Could not stage debug artifacts, so none will be published: ${message}`,
    );
    process.exit(1);
  });
}
