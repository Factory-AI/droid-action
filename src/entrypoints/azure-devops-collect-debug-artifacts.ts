#!/usr/bin/env bun

/**
 * Stages the prompts directory (prompts, pass logs, candidate and validated
 * JSON, the error file) into the directory the pipeline publishes as the
 * `droid-debug-<attempt>` build artifact, with every credential the job
 * holds redacted. The pass logs are raw stream-json, so they include the
 * output of any command Droid ran.
 */

import { collectDebugArtifacts } from "../utils/debug-artifacts";
import { debugArtifactsDir, promptsDir } from "../azure-devops/paths";
import { azureDevopsSecretValues } from "../azure-devops/token";

export async function run(env: NodeJS.ProcessEnv = process.env) {
  const outputDir = debugArtifactsDir(env);
  const result = await collectDebugArtifacts({
    sources: [{ from: promptsDir(env), to: "." }],
    outputDir,
    secrets: azureDevopsSecretValues(env),
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
