#!/usr/bin/env bun

/**
 * Stages Droid's logs, session transcripts and review prompts for the
 * opt-in debug artifact, with every credential the job holds redacted.
 */

import * as core from "@actions/core";
import { homedir } from "os";
import path from "path";
import {
  collectDebugArtifacts,
  type DebugArtifactSource,
} from "../utils/debug-artifacts";
import {
  GITHUB_CREDENTIAL_ENV_NAMES,
  secretValuesFromEnv,
} from "../utils/redact-credentials";

export function githubDebugArtifactSources(
  home: string,
  runnerTemp: string,
): DebugArtifactSource[] {
  const factoryDir = path.join(home, ".factory");
  // Only the CLI's logs and sessions: the rest of ~/.factory is configuration,
  // and its mcp.json holds the GitHub token in each MCP server's env.
  return [
    { from: path.join(factoryDir, "logs"), to: "factory/logs" },
    { from: path.join(factoryDir, "sessions"), to: "factory/sessions" },
    { from: path.join(runnerTemp, "droid-prompts"), to: "droid-prompts" },
  ];
}

export async function run(): Promise<void> {
  const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
  const outputDir =
    process.env.DEBUG_ARTIFACTS_DIR ||
    path.join(runnerTemp, "droid-debug-artifacts");

  try {
    const result = await collectDebugArtifacts({
      sources: githubDebugArtifactSources(
        process.env.HOME || homedir(),
        runnerTemp,
      ),
      outputDir,
      secrets: secretValuesFromEnv(GITHUB_CREDENTIAL_ENV_NAMES),
    });
    console.log(
      `Staged ${result.files} debug files with credentials redacted in ${outputDir}.`,
    );
    if (result.skipped.length > 0) {
      console.log(
        `Left out ${result.skipped.length} symlinks or credential files.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(
      `Could not stage debug artifacts, so none will be uploaded: ${message}`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
