#!/usr/bin/env bun

import * as core from "@actions/core";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  prepareDebugArtifacts,
  type DebugArtifactMode,
} from "../debug-artifacts/collect";

function getMode(env: NodeJS.ProcessEnv): DebugArtifactMode {
  const mode = (env.DEBUG_ARTIFACTS_MODE ?? env.DEBUG_ARTIFACTS ?? "redacted")
    .trim()
    .toLowerCase();

  if (mode === "none" || mode === "redacted") return mode;
  throw new Error("DEBUG_ARTIFACTS_MODE must be one of: none, redacted");
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function prepareDebugArtifactsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
) {
  const outputDir = requireEnv(env, "DEBUG_ARTIFACTS_DIR");
  const factoryHome = env.FACTORY_HOME ?? join(homedir(), ".factory");
  const droidPromptsDir =
    env.DROID_PROMPTS_DIR ?? join(env.RUNNER_TEMP ?? "/tmp", "droid-prompts");

  return prepareDebugArtifacts({
    mode: getMode(env),
    outputDir,
    factoryHome,
    droidPromptsDir,
  });
}

async function run() {
  try {
    const result = await prepareDebugArtifactsFromEnv();
    core.info(
      result.prepared
        ? `Prepared ${result.files.length} redacted debug artifact files`
        : "Debug artifact mode is none; no bundle prepared",
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(`Prepare debug artifacts failed: ${errorMessage}`);
    process.exit(1);
  }
}

export default run;

if (import.meta.main) {
  run();
}
