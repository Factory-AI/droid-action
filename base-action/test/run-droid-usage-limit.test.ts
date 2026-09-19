import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runDroid } from "../src/run-droid";

/**
 * Stand-in for `droid exec --output-format stream-json` on an organization
 * whose weekly usage limit is exhausted: the agent loop reports the raw 402,
 * the CLI reports the (empty) final text, and the process exits 1. Records
 * every invocation so the test can prove it ran exactly once.
 */
const USAGE_LIMITED_DROID = `#!/usr/bin/env bash
echo run >> "$DROID_FAKE_INVOCATIONS"
echo '{"type":"system","subtype":"init","cwd":"/","session_id":"s","tools":[],"model":"m","reasoning_effort":"medium"}'
echo '{"type":"message","role":"user","id":"u1","text":"review this PR","timestamp":1,"session_id":"s"}'
echo '{"type":"error","source":"agent_loop","message":"402 {\\"detail\\":\\"You'"'"'ve reached your weekly Droid Core usage limit (resets in 5 days).\\\\nReload Extra Usage credits or wait for your limits to reset.\\",\\"status\\":402,\\"displayToUser\\":true}","timestamp":2,"session_id":"s"}'
echo '{"type":"error","source":"cli","message":"Exec failed","timestamp":3,"session_id":"s"}'
exit 1
`;

describe("runDroid usage limit", () => {
  let dir: string;
  let fakeDroid: string;
  let promptPath: string;
  let invocationsPath: string;
  let outputs: Record<string, string>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;
  const originalInvocations = process.env.DROID_FAKE_INVOCATIONS;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "droid-usage-limit-"));
    fakeDroid = join(dir, "droid");
    promptPath = join(dir, "prompt.txt");
    invocationsPath = join(dir, "invocations.log");
    await writeFile(fakeDroid, USAGE_LIMITED_DROID);
    await chmod(fakeDroid, 0o755);
    await writeFile(promptPath, "review this PR");
    process.env.DROID_FAKE_INVOCATIONS = invocationsPath;
    outputs = {};
    setOutputSpy = spyOn(core, "setOutput").mockImplementation(
      (name: string, value: unknown) => {
        outputs[name] = String(value);
      },
    );
  });

  afterEach(async () => {
    setOutputSpy.mockRestore();
    exitSpy?.mockRestore();
    if (originalInvocations === undefined) {
      delete process.env.DROID_FAKE_INVOCATIONS;
    } else {
      process.env.DROID_FAKE_INVOCATIONS = originalInvocations;
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("fails once with the limit detail instead of retrying", async () => {
    let exitCode: number | undefined;
    exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never);

    const started = Date.now();
    await expect(
      runDroid(promptPath, {
        pathToDroidExecutable: fakeDroid,
        showFullOutput: "false",
      }),
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    expect(outputs.conclusion).toBe("failure");
    expect(outputs.error_message).toContain("usage limit was reached");
    expect(outputs.error_message).toContain(
      "You've reached your weekly Droid Core usage limit (resets in 5 days).",
    );
    // The raw JSON body must not leak into the PR comment.
    expect(outputs.error_message).not.toContain('"status"');

    const invocations = await readFile(invocationsPath, "utf8");
    expect(invocations.trim().split("\n")).toHaveLength(1);
    // A retry would have waited for the 5s backoff before re-spawning; the
    // usage-limit guard must short-circuit that.
    expect(Date.now() - started).toBeLessThan(4000);
  }, 15000);
});
