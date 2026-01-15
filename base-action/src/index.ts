#!/usr/bin/env bun

import * as core from "@actions/core";
import { preparePrompt } from "./prepare-prompt";
import { runDroid } from "./run-droid";
import { setupDroidSettings } from "./setup-droid-settings";
import { validateEnvironmentVariables } from "./validate-env";

async function run() {
  try {
    validateEnvironmentVariables();

    await setupDroidSettings(
      process.env.INPUT_SETTINGS,
      undefined, // homeDir
    );

    const promptConfig = await preparePrompt({
      prompt: process.env.INPUT_PROMPT || "",
      promptFile: process.env.INPUT_PROMPT_FILE || "",
    });

    await runDroid(promptConfig.path, {
      droidArgs: process.env.INPUT_DROID_ARGS,
      allowedTools: process.env.INPUT_ALLOWED_TOOLS,
      disallowedTools: process.env.INPUT_DISALLOWED_TOOLS,
      maxTurns: process.env.INPUT_MAX_TURNS,
      mcpTools: process.env.INPUT_MCP_TOOLS,
      systemPrompt: process.env.INPUT_SYSTEM_PROMPT,
      appendSystemPrompt: process.env.INPUT_APPEND_SYSTEM_PROMPT,
      pathToDroidExecutable: process.env.INPUT_PATH_TO_DROID_EXECUTABLE,
      showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
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
