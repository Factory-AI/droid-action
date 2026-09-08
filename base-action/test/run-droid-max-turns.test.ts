import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { chmod, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runDroid } from "../src/run-droid";

/**
 * Stand-in for `droid exec` that emits one assistant turn per interval,
 * forever, in stream-json format. Never exits on its own, so the only way
 * the run ends is the turn cap killing it.
 */
const RUNAWAY_DROID = `#!/usr/bin/env bash
i=0
while true; do
  i=$((i+1))
  printf '{"type":"message","role":"assistant","id":"m'
  sleep 0.01
  echo ''"$i"'","text":"again","session_id":"s"}'
  echo '{"type":"tool_call","id":"c'"$i"'","messageId":"m'"$i"'","toolId":"github_pr___submit_review"}'
  sleep 0.05
done
`;

describe("runDroid turn cap", () => {
  let dir: string;
  let fakeDroid: string;
  let promptPath: string;
  let outputs: Record<string, string>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "droid-max-turns-"));
    fakeDroid = join(dir, "droid");
    promptPath = join(dir, "prompt.txt");
    await writeFile(fakeDroid, RUNAWAY_DROID);
    await chmod(fakeDroid, 0o755);
    await writeFile(promptPath, "loop forever");
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
    await rm(dir, { recursive: true, force: true });
  });

  test("kills a runaway agent at the cap without retrying it", async () => {
    let exitCode: number | undefined;
    exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never);

    const started = Date.now();
    await expect(
      runDroid(promptPath, {
        pathToDroidExecutable: fakeDroid,
        maxTurns: "5",
        showFullOutput: "false",
      }),
    ).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    expect(outputs.conclusion).toBe("failure");
    expect(outputs.error_message).toContain("maximum of 5 turns");
    // A retry would have waited for the 5s backoff before re-spawning; the
    // cap must short-circuit that.
    expect(Date.now() - started).toBeLessThan(4000);
  }, 15000);
});
