import * as core from "@actions/core";
import { createHash } from "crypto";
import { readFile, realpath } from "fs/promises";
import { isAbsolute } from "path";

/** Runs after CLI installation and before the first model starts. */
export async function freezeReviewCli(
  input = process.env.INPUT_PATH_TO_DROID_EXECUTABLE,
) {
  const candidate = input?.trim() || Bun.which("droid");
  if (!candidate)
    throw new Error("Could not locate the trusted Droid executable");
  const executable = await realpath(candidate);
  if (!isAbsolute(executable))
    throw new Error("Droid executable must resolve to an absolute path");
  const outputs = {
    review_cli_path: executable,
    review_cli_sha256: createHash("sha256")
      .update(await readFile(executable))
      .digest("hex"),
    review_path: process.env.PATH || "/usr/bin:/bin",
    review_home: process.env.HOME || "",
  };
  for (const [key, value] of Object.entries(outputs))
    core.setOutput(key, value);
  return outputs;
}
if (import.meta.main)
  freezeReviewCli().catch((error) => {
    core.setFailed(
      error instanceof Error
        ? error.message
        : "Could not freeze Droid executable",
    );
    process.exitCode = 1;
  });
