#!/usr/bin/env bun

import * as core from "@actions/core";
import { preparePrompt } from "./prepare-prompt";
import { runDroid } from "./run-droid";
import { setupDroidSettings } from "./setup-droid-settings";
import { validateEnvironmentVariables } from "./validate-env";
import { createCommandProfile } from "./command-profile";
import { resolve } from "path";

async function run() {
  try {
    validateEnvironmentVariables();

    const commandMode = process.env.DROID_COMMAND_MODE;
    const profile =
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
    core.setFailed(`Action failed with error: ${error}`);
    core.setOutput("conclusion", "failure");
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
