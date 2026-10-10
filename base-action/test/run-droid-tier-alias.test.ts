import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runDroid } from "../src/run-droid";

/**
 * Stand-in for a Droid CLI that predates tier aliases: any `*-latest-*`
 * model fails fast with `Invalid model:`. With DROID_FAKE_BLOCKED set, that
 * concrete model is rejected by the org policy pre-flight instead. Records
 * the args of every invocation.
 */
const PRE_ALIAS_DROID = `#!/usr/bin/env bash
echo "$*" >> "$DROID_FAKE_INVOCATIONS"
case "$DROID_FAKE_ERROR" in
  result)
    echo '{"type":"result","is_error":true,"result":"This model requires explicit organization opt-in by an admin."}'
    exit 1 ;;
  agent_loop)
    echo '{"type":"error","source":"agent_loop","message":"This model requires explicit organization opt-in by an admin."}'
    exit 1 ;;
  invalid)
    echo 'Invalid model: unsupported-model' >&2
    exit 1 ;;
  transient)
    if [ "$(wc -l < "$DROID_FAKE_INVOCATIONS")" -eq 1 ]; then
      echo '503 Service Unavailable' >&2
      exit 1
    fi ;;
esac
case "$*" in
  *-latest-*)
    echo "Invalid model: $(echo "$*" | grep -oE '[a-z0-9]+-latest-[a-z]+')" >&2
    exit 1 ;;
esac
if [ -n "$DROID_FAKE_BLOCKED" ] && [[ "$*" == *"--model $DROID_FAKE_BLOCKED"* ]]; then
  echo "Model blocked by organization policy" >&2
  exit 1
fi
echo '{"type":"result","is_error":false,"result":"ok"}'
exit 0
`;

describe("runDroid with a CLI that predates tier aliases", () => {
  let dir: string;
  let fakeDroid: string;
  let promptPath: string;
  let invocationsPath: string;
  let outputs: Record<string, string>;
  let setOutputSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn> | undefined;
  const originalEnv = {
    invocations: process.env.DROID_FAKE_INVOCATIONS,
    blocked: process.env.DROID_FAKE_BLOCKED,
    error: process.env.DROID_FAKE_ERROR,
  };

  const restoreEnv = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  const invocations = async () =>
    (await readFile(invocationsPath, "utf8")).trim().split("\n");

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "droid-tier-alias-"));
    fakeDroid = join(dir, "droid");
    promptPath = join(dir, "prompt.txt");
    invocationsPath = join(dir, "invocations.log");
    await writeFile(fakeDroid, PRE_ALIAS_DROID);
    await chmod(fakeDroid, 0o755);
    await writeFile(promptPath, "review this PR");
    process.env.DROID_FAKE_INVOCATIONS = invocationsPath;
    delete process.env.DROID_FAKE_BLOCKED;
    delete process.env.DROID_FAKE_ERROR;
    exitSpy = undefined;
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
    restoreEnv("DROID_FAKE_INVOCATIONS", originalEnv.invocations);
    restoreEnv("DROID_FAKE_BLOCKED", originalEnv.blocked);
    restoreEnv("DROID_FAKE_ERROR", originalEnv.error);
    await rm(dir, { recursive: true, force: true });
  });

  test("reruns with the concrete stand-in and posts no note", async () => {
    const started = Date.now();
    await runDroid(promptPath, {
      pathToDroidExecutable: fakeDroid,
      droidArgs: "--model openai-latest-balanced --reasoning-effort high",
      showFullOutput: "false",
    });

    expect(outputs.conclusion).toBe("success");
    expect(outputs.model_fallback_note).toBeUndefined();
    const calls = await invocations();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--model gpt-5.6-sol");
    expect(calls[1]).toContain("--reasoning-effort high");
    // The swap happens within the attempt, without the 5s retry backoff.
    expect(Date.now() - started).toBeLessThan(4000);
  }, 15000);

  test("names the requested alias when the stand-in is policy-blocked", async () => {
    process.env.DROID_FAKE_BLOCKED = "gpt-5.6-sol";

    await runDroid(promptPath, {
      pathToDroidExecutable: fakeDroid,
      droidArgs: "--model openai-latest-balanced --reasoning-effort high",
      showFullOutput: "false",
    });

    expect(outputs.conclusion).toBe("success");
    expect(outputs.model_fallback_note).toContain(
      "The model `openai-latest-balanced` is not allowed",
    );
    expect(outputs.model_fallback_note).not.toContain("gpt-5.6-sol");
    const calls = await invocations();
    expect(calls).toHaveLength(3);
    expect(calls[2]).not.toContain("--model");
  }, 20000);

  test.each(["invalid alias", "invalid", "stderr", "result", "agent_loop"])(
    "fails once without substituting the model for %s",
    async (source) => {
      const model =
        source === "invalid alias" ? "openai-latest-balanced" : "gpt-5.6-sol";
      if (source === "stderr") process.env.DROID_FAKE_BLOCKED = model;
      else if (source !== "invalid alias")
        process.env.DROID_FAKE_ERROR = source;
      exitSpy = spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });
      const started = Date.now();
      await expect(
        runDroid(promptPath, {
          pathToDroidExecutable: fakeDroid,
          droidArgs: `--model ${model} --reasoning-effort high`,
          modelPolicyFallback: "fail",
        }),
      ).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(outputs.conclusion).toBe("failure");
      expect(outputs.error_message).toContain(
        source.startsWith("invalid")
          ? "Invalid model:"
          : source === "stderr"
            ? "Model blocked by organization policy"
            : "requires explicit organization opt-in",
      );
      expect(outputs.model_fallback_note).toBeUndefined();
      const calls = await invocations();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(`--model ${model} --reasoning-effort high`);
      expect(Date.now() - started).toBeLessThan(4000);
    },
    20000,
  );

  test("still retries transient failures in fail mode with unchanged arguments", async () => {
    process.env.DROID_FAKE_ERROR = "transient";
    await runDroid(promptPath, {
      pathToDroidExecutable: fakeDroid,
      droidArgs: "--model gpt-5.6-sol --reasoning-effort high",
      modelPolicyFallback: "fail",
    });
    expect(outputs.conclusion).toBe("success");
    expect(outputs.model_fallback_note).toBeUndefined();
    const calls = await invocations();
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(1);
  }, 15000);
});
