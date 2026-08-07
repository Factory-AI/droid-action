import * as core from "@actions/core";
import { mkdir, writeFile } from "fs/promises";
import { checkHumanActor } from "../github/validation/actor";
import { isEntityContext, type GitHubContext } from "../github/context";
import { normalizeDroidArgs } from "../utils/parse-tools";
import type { PrepareOptions, PrepareResult } from "../prepare/types";

/**
 * Custom automation mode: runs the workflow's `prompt` input directly via
 * Droid Exec. This is the execution path for Factory-managed Custom CI
 * automations, whose task is free text authored in the Factory Automations UI
 * rather than an @droid command or a review flow.
 *
 * Triggers whenever a non-empty `prompt` input is present. Dispatch precedence
 * lives in `src/prepare/index.ts`: explicit @droid commands and the
 * automatic-review flags always win, so a prompt only runs when no tag/review
 * flow claimed the event.
 */
export function shouldTriggerCustomAutomation(context: GitHubContext): boolean {
  return context.inputs.prompt.trim().length > 0;
}

function describeTriggeringEvent(context: GitHubContext): string {
  if (!isEntityContext(context)) {
    return `a \`${context.eventName}\` event`;
  }
  const entityKind = context.isPR ? "pull request" : "issue";
  return `a \`${context.eventName}\` event on ${entityKind} #${context.entityNumber}`;
}

function buildCustomAutomationPrompt(context: GitHubContext): string {
  const { repository } = context;
  return `You are running as a Factory custom automation inside a GitHub Actions runner.

Environment:
- Repository: ${repository.full_name} (already checked out in the working directory)
- Triggered by: ${describeTriggeringEvent(context)}
- The \`gh\` CLI is authenticated via the GITHUB_TOKEN environment variable.
- This is a non-interactive environment: never wait for user input, and complete the task in this single run.
- If your task produces code changes, create a new branch and open a pull request with \`gh\`; do not push directly to the default branch.

Your task:

${context.inputs.prompt.trim()}
`;
}

export async function prepareCustomAutomationMode({
  context,
  octokit,
}: PrepareOptions): Promise<PrepareResult> {
  // Entity-triggered automations (e.g. `on: pull_request` with a prompt) keep
  // the same actor hygiene as the tag flows: bot-authored events only run when
  // the bot is explicitly allow-listed. Automation events (schedule /
  // workflow_dispatch / ...) have no meaningful actor to validate.
  if (isEntityContext(context)) {
    await checkHumanActor(octokit.rest, context);
  }

  const promptContent = buildCustomAutomationPrompt(context);

  console.log("===== CUSTOM AUTOMATION PROMPT =====");
  console.log(promptContent);
  console.log("====================================");

  const promptDir = `${process.env.RUNNER_TEMP || "/tmp"}/droid-prompts`;
  await mkdir(promptDir, { recursive: true });
  await writeFile(`${promptDir}/droid-prompt.txt`, promptContent);

  core.exportVariable("DROID_EXEC_RUN_TYPE", "droid-custom-automation");

  // Pass user-supplied droid_args through untouched (this is how Factory's
  // Custom CI automations carry their model selection, e.g. `-m <model>`).
  // No tool restrictions are imposed: the task is arbitrary by design.
  const normalizedUserArgs = normalizeDroidArgs(process.env.DROID_ARGS || "");
  core.setOutput("droid_args", normalizedUserArgs);
  core.setOutput("mcp_tools", "");

  return {
    branchInfo: {
      baseBranch: "",
      currentBranch: "",
    },
    mcpTools: "",
  };
}
