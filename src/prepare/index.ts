/**
 * Main prepare module that delegates to the mode's prepare method
 */

import type { PrepareOptions, PrepareResult } from "./types";
import { prepareTagExecution } from "../tag";
import { createLogger } from "../logger";

const log = createLogger("prepare/index");

export async function prepare(options: PrepareOptions): Promise<PrepareResult> {
  const { context } = options;

  log.info(`Preparing tag execution for event: ${context.eventName}`);

  return prepareTagExecution(options);
}
