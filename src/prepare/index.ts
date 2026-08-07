/**
 * Main prepare module that delegates to the mode's prepare method
 */

import type { PrepareOptions, PrepareResult } from "./types";
import { shouldTriggerTag, prepareTagExecution } from "../tag";
import {
  shouldTriggerCustomAutomation,
  prepareCustomAutomationMode,
} from "../custom-automation";

export async function prepare(options: PrepareOptions): Promise<PrepareResult> {
  const { context } = options;

  // Explicit @droid commands and the automatic-review flags always win; the
  // custom automation prompt only runs when no tag/review flow claimed the
  // event (schedule / workflow_dispatch runs, or entity events with no
  // command).
  if (shouldTriggerTag(context)) {
    console.log(`Preparing tag execution for event: ${context.eventName}`);
    return prepareTagExecution(options);
  }

  if (shouldTriggerCustomAutomation(context)) {
    console.log(
      `Preparing custom automation execution for event: ${context.eventName}`,
    );
    return prepareCustomAutomationMode(options);
  }

  throw new Error(
    `No execution mode matched event: ${context.eventName}. This indicates a trigger-detection bug in the prepare entrypoint.`,
  );
}
