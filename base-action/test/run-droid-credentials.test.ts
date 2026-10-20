import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@actions/core";
import { chmod, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { buildDroidEnv, runDroid } from "../src/run-droid";

// Neither value matches a known token format, so only exact-value redaction
// can catch them.
const INSTALLATION_TOKEN = "installation-token-value-0123456789";
const FACTORY_KEY = "factory-key-value-abcdefghijklmnop";
const PATTERN_TOKEN = `ghs_${"A".repeat(36)}`;

/**
 * Stand-in for `droid exec` that records the environment it was given and
 * echoes credentials on every channel the action forwards to the job log or
 * to the pull request.
 */
const LEAKY_DROID = `#!/usr/bin/env bash
env > "$DROID_FAKE_ENV_DUMP"
echo '{"type":"system","subtype":"init","cwd":"/","session_id":"s","tools":[],"model":"m"}'
echo "{\\"type\\":\\"message\\",\\"role\\":\\"assistant\\",\\"text\\":\\"$GITHUB_TOKEN ${PATTERN_TOKEN}\\"}"
echo "not json $FACTORY_API_KEY"
echo "stderr $GITHUB_TOKEN" >&2
if [ "$DROID_FAKE_EXIT" = "1" ]; then
  echo '{"type":"result","subtype":"error","is_error":true,"result":"failed with '"$GITHUB_TOKEN"'"}'
  exit 1
fi
echo '{"type":"result","subtype":"success","is_error":false,"duration_ms":1}'
`;

const WITHHELD = {
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token-value",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/oidc",
  ACTIONS_RUNTIME_TOKEN: "runtime-token-value-123",
  GITHUB_ENV: "/tmp/github-env-file",
  GITHUB_PATH: "/tmp/github-path-file",
  GITHUB_OUTPUT: "/tmp/github-output-file",
  OVERRIDE_GITHUB_TOKEN: "override-token-value-123",
  DEFAULT_WORKFLOW_TOKEN: "workflow-token-value-123",
  INPUT_MCP_TOOLS: '{"mcpServers":{}}',
};

describe("buildDroidEnv", () => {
  test("withholds runner credentials and file-command paths", () => {
    const env = buildDroidEnv(
      { ...WITHHELD, PATH: "/usr/bin", GITHUB_TOKEN: INSTALLATION_TOKEN },
      { DROID_EXTRA: "1" },
    );

    for (const name of Object.keys(WITHHELD)) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GITHUB_TOKEN).toBe(INSTALLATION_TOKEN);
    expect(env.DROID_EXTRA).toBe("1");
  });
});

describe("runDroid credential handling", () => {
  let dir: string;
  let fakeDroid: string;
  let promptPath: string;
  let envDumpPath: string;
  let outputs: Record<string, string>;
  let stdout: string;
  let stderr: string;
  const spies: { mockRestore: () => void }[] = [];
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "droid-credentials-"));
    fakeDroid = join(dir, "droid");
    promptPath = join(dir, "prompt.txt");
    envDumpPath = join(dir, "env.txt");
    await writeFile(fakeDroid, LEAKY_DROID);
    await chmod(fakeDroid, 0o755);
    await writeFile(promptPath, "review this PR");

    Object.assign(process.env, WITHHELD, {
      GITHUB_TOKEN: INSTALLATION_TOKEN,
      FACTORY_API_KEY: FACTORY_KEY,
      DROID_FAKE_ENV_DUMP: envDumpPath,
    });

    outputs = {};
    stdout = "";
    stderr = "";
    spies.push(
      spyOn(core, "setOutput").mockImplementation(
        (name: string, value: unknown) => {
          outputs[name] = String(value);
        },
      ),
      spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
        stdout += String(chunk);
        return true;
      }) as never),
      spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
        stderr += String(chunk);
        return true;
      }) as never),
      spyOn(console, "log").mockImplementation(() => {}),
      spyOn(console, "error").mockImplementation(() => {}),
    );
  });

  afterEach(async () => {
    while (spies.length) spies.pop()!.mockRestore();
    for (const name of Object.keys(process.env)) {
      if (!(name in originalEnv)) delete process.env[name];
    }
    Object.assign(process.env, originalEnv);
    await rm(dir, { recursive: true, force: true });
  });

  test("spawns Droid without runner credentials or file-command paths", async () => {
    await runDroid(promptPath, {
      pathToDroidExecutable: fakeDroid,
      showFullOutput: "false",
    });

    const dumped = await readFile(envDumpPath, "utf8");
    for (const [name, value] of Object.entries(WITHHELD)) {
      expect(dumped).not.toContain(`${name}=`);
      expect(dumped).not.toContain(value);
    }
    expect(dumped).toContain(`GITHUB_TOKEN=${INSTALLATION_TOKEN}`);
    expect(outputs.conclusion).toBe("success");
  });

  test("redacts credentials from full output and stderr", async () => {
    await runDroid(promptPath, {
      pathToDroidExecutable: fakeDroid,
      showFullOutput: "true",
    });

    expect(stdout).toContain('"role": "assistant"');
    expect(stdout).toContain("not json");
    expect(stderr).toContain("stderr [REDACTED]");
    for (const secret of [INSTALLATION_TOKEN, FACTORY_KEY, PATTERN_TOKEN]) {
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    }
  });

  test("redacts credentials from the error message posted to the PR", async () => {
    process.env.DROID_FAKE_EXIT = "1";
    spies.push(
      spyOn(process, "exit").mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never),
    );

    await expect(
      runDroid(promptPath, {
        pathToDroidExecutable: fakeDroid,
        showFullOutput: "false",
      }),
    ).rejects.toThrow("process.exit(1)");

    expect(outputs.conclusion).toBe("failure");
    expect(outputs.error_message).toBe("failed with [REDACTED]");
  }, 30000);
});
