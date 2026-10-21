import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  MAX_ERROR_DETAILS_CHARS,
  readErrorDetails,
} from "../../src/gitlab/operations/error-details";

describe("readErrorDetails", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "droid-error-details-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads a regular file", async () => {
    const file = path.join(tmpDir, "droid-error.txt");
    await fs.writeFile(file, "droid exec pass 1 failed\n");
    expect(await readErrorDetails(file, {})).toBe("droid exec pass 1 failed");
  });

  it("returns null when the file is missing or empty", async () => {
    expect(await readErrorDetails(path.join(tmpDir, "nope"), {})).toBeNull();
    const empty = path.join(tmpDir, "empty");
    await fs.writeFile(empty, "  \n");
    expect(await readErrorDetails(empty, {})).toBeNull();
  });

  it("refuses a symlink, even to a readable file", async () => {
    const secret = path.join(tmpDir, "secret");
    await fs.writeFile(secret, "SECRET");
    const link = path.join(tmpDir, "droid-error.txt");
    await fs.symlink(secret, link);
    expect(await readErrorDetails(link, {})).toBeNull();
  });

  it("refuses a directory or FIFO", async () => {
    expect(await readErrorDetails(tmpDir, {})).toBeNull();
  });

  it("caps the size", async () => {
    const file = path.join(tmpDir, "big");
    await fs.writeFile(file, "y".repeat(200_000));
    const text = (await readErrorDetails(file, {}))!;
    expect(text.startsWith("y".repeat(MAX_ERROR_DETAILS_CHARS))).toBe(true);
    expect(text.length).toBeLessThan(MAX_ERROR_DETAILS_CHARS + 50);
    expect(text).toContain("(truncated)");
  });

  it("redacts credentials, including one straddling the cap", async () => {
    const secret = "job-secret-value-abcdefgh";
    const file = path.join(tmpDir, "leak");
    const padding = "z".repeat(MAX_ERROR_DETAILS_CHARS - 10);
    await fs.writeFile(
      file,
      `${padding}${secret} and ${"glpat-" + "q".repeat(20)}`,
    );
    const text = (await readErrorDetails(file, { CI_JOB_TOKEN: secret }))!;
    expect(text).not.toContain(secret.slice(0, 10));
    expect(text).not.toContain("glpat-");

    await fs.writeFile(
      file,
      `token ${secret} and ${"glpat-" + "q".repeat(20)}`,
    );
    const short = (await readErrorDetails(file, { CI_JOB_TOKEN: secret }))!;
    expect(short).toBe("token [REDACTED] and [REDACTED_GITLAB_TOKEN]");
  });
});
