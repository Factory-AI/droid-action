import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { redactCredentials } from "../../utils/redact-credentials";

const MAX_LOGGED_ERROR_CHARS = 2000;
export const FAILURE_REASON = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * A step's failure: a sentence for the job log, and the short machine label
 * the failure is reported under where a report has a place for one.
 */
export class StepError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StepError";
    this.reason = reason;
  }
}

/** The label a failure is reported under; anything unlabelled is `unexpected`. */
export function failureReason(error: unknown): string {
  return error instanceof StepError && FAILURE_REASON.test(error.reason)
    ? error.reason
    : "unexpected";
}

export function requiredEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name]?.trim();
  if (!value) throw new StepError("env_missing", `${name} is not set`);
  return value;
}

/** An error's message with the job's credentials removed, for the log. */
export function describeFailure(error: unknown): string {
  return redactCredentials(
    error instanceof Error ? error.message : String(error),
  ).slice(0, MAX_LOGGED_ERROR_CHARS);
}

/** Writes a file only its owner can read, in a directory only they can open. */
export async function writePrivateFile(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, data, { mode: 0o600 });
  // writeFile applies its mode only when it creates the file.
  await chmod(path, 0o600);
}

/** Writes JSON only its owner can read: these files carry a served judge. */
export function writePrivateJson(path: string, value: unknown): Promise<void> {
  return writePrivateFile(path, JSON.stringify(value));
}
