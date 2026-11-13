import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Writes a value one risk step hands to a later one. The digest goes into
 * the writing step's outputs, which nothing running on the machine can
 * change afterwards.
 */
export async function writeRiskHandoff(
  directory: string,
  name: string,
  value: unknown,
): Promise<{ path: string; sha256: string }> {
  const bytes = Buffer.from(JSON.stringify(value));
  const path = join(directory, name);
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, sha256: sha256(bytes) };
}

/**
 * Reads a handed-off value back, refusing bytes that are not the ones the
 * earlier step wrote: a review or judge session, or a process one left
 * behind, runs as the same user and can rewrite the file in between.
 */
export async function readRiskHandoff(
  path: string | undefined,
  expectedSha256: string | undefined,
): Promise<unknown> {
  if (!path || !expectedSha256 || !/^[a-f0-9]{64}$/u.test(expectedSha256))
    throw new Error("A risk step's handoff is missing");
  const bytes = await readFile(path);
  if (sha256(bytes) !== expectedSha256)
    throw new Error("A risk step's handoff changed after it was written");
  return JSON.parse(bytes.toString("utf8"));
}
