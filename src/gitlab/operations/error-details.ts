/**
 * Reads the error file the CI template writes on failure, for the tracking
 * note. The file lives in /tmp, where the review passes can replace it with a
 * symlink to any file the job can read (/proc/self/environ, a credentials
 * file), so only a regular file is read, through O_NOFOLLOW, and the text is
 * capped and redacted before it can reach the MR.
 */

import { constants } from "fs";
import { open } from "fs/promises";
import { redactCredentials } from "../../utils/redact-credentials";

export const DEFAULT_ERROR_FILE = "/tmp/droid-error.txt";
export const MAX_ERROR_DETAILS_CHARS = 4096;

// Read well past the cap so a credential straddling the cut is still whole
// when it is redacted, and only then trim.
const READ_LIMIT_BYTES = 64 * 1024;
const TRUNCATED_SUFFIX = "\n... (truncated)";

export function capErrorDetails(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  maxChars: number = MAX_ERROR_DETAILS_CHARS,
): string {
  const redacted = redactCredentials(text, env);
  return redacted.length > maxChars
    ? `${redacted.slice(0, maxChars)}${TRUNCATED_SUFFIX}`
    : redacted;
}

export async function readErrorDetails(
  filePath: string = DEFAULT_ERROR_FILE,
  env: NodeJS.ProcessEnv = process.env,
  maxChars: number = MAX_ERROR_DETAILS_CHARS,
): Promise<string | null> {
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      console.warn(`${filePath} is not a regular file; ignoring it.`);
      return null;
    }
    const buffer = Buffer.alloc(Math.min(info.size, READ_LIMIT_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8").trim();
    if (!text) {
      return null;
    }
    return capErrorDetails(text, env, maxChars);
  } finally {
    await handle.close();
  }
}
