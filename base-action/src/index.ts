#!/usr/bin/env bun

import * as core from "@actions/core";
import { preparePrompt } from "./prepare-prompt";
import { IsolatedDroidError, runDroid } from "./run-droid";
import { setupDroidSettings } from "./setup-droid-settings";
import { validateEnvironmentVariables } from "./validate-env";
import { createCommandProfile, type CommandProfile } from "./command-profile";
import { redactCredentials } from "./utils/redact-credentials";
import { resolve } from "path";

async function run() {
  let profile: CommandProfile | undefined;
  try {
    validateEnvironmentVariables();

    const commandMode = process.env.DROID_COMMAND_MODE;
    profile =
      commandMode === "fix" || commandMode === "question"
        ? await createCommandProfile(commandMode)
        : undefined;
    if (!profile) {
      await setupDroidSettings(
        process.env.INPUT_SETTINGS,
        undefined, // homeDir
      );
    }

    const promptConfig = await preparePrompt({
      prompt: process.env.INPUT_PROMPT || "",
      promptFile: process.env.INPUT_PROMPT_FILE || "",
    });

    await runDroid(resolve(promptConfig.path), {
      droidArgs: profile?.args ?? process.env.INPUT_DROID_ARGS,
      reasoningEffort: profile ? undefined : process.env.INPUT_REASONING_EFFORT,
      allowedTools: profile ? undefined : process.env.INPUT_ALLOWED_TOOLS,
      disallowedTools: profile ? undefined : process.env.INPUT_DISALLOWED_TOOLS,
      maxTurns: process.env.INPUT_MAX_TURNS,
      mcpTools: profile ? undefined : process.env.INPUT_MCP_TOOLS,
      systemPrompt: profile ? undefined : process.env.INPUT_SYSTEM_PROMPT,
      appendSystemPrompt: profile
        ? undefined
        : process.env.INPUT_APPEND_SYSTEM_PROMPT,
      pathToDroidExecutable: process.env.INPUT_PATH_TO_DROID_EXECUTABLE,
      showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
      isolatedProfile: profile,
    });
  } catch (error) {
    core.setFailed(redactCredentials(`Action failed with error: ${error}`));
    core.setOutput("conclusion", "failure");
    if (profile) {
      process.exitCode =
        error instanceof IsolatedDroidError ? error.exitCode : 1;
    } else {
      process.exit(1);
    }
  } finally {
    await profile?.cleanup();
  }
}

if (import.meta.main) {
  run();
}
