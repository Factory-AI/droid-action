import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { run as collect } from "../../src/entrypoints/azure-devops-collect-debug-artifacts";
import { tempDir } from "./helpers";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const SECRETS = {
  SYSTEM_ACCESSTOKEN: "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.job-token",
  AZURE_DEVOPS_PAT: "abcdefghijklmnopqrstuvwxyz0123456789AZDOabcd",
  AZURE_DEVOPS_EXT_PAT: "ext-pat-value-0123456789",
  FACTORY_API_KEY: "factory-key-value-0123456789",
};

function setup() {
  const root = tempDir("ado-collect-");
  dirs.push(root);
  const prompts = path.join(root, "droid-prompts");
  const debug = path.join(root, "droid-debug");
  fs.mkdirSync(prompts);
  fs.mkdirSync(debug);
  const env = {
    ...SECRETS,
    DROID_PROMPT_FILE: path.join(prompts, "droid-prompt.txt"),
    DROID_DEBUG_DIR: debug,
  };
  return { root, prompts, debug, env };
}

describe("azure-devops-collect-debug-artifacts", () => {
  it("copies the prompts directory with every Azure DevOps credential redacted", async () => {
    const { prompts, debug, env } = setup();
    // What a pass log looks like after Droid ran `env`.
    const log = Object.entries(SECRETS)
      .map(([k, v]) =>
        JSON.stringify({ type: "tool_result", text: `${k}=${v}` }),
      )
      .join("\n");
    fs.writeFileSync(path.join(prompts, "pass1-output.jsonl"), log);
    fs.writeFileSync(path.join(prompts, "droid-prompt.txt"), "review this");
    fs.writeFileSync(path.join(debug, "stale.txt"), "from an earlier attempt");

    const result = await collect(env);
    expect(result.files).toBe(2);
    expect(fs.readdirSync(debug).sort()).toEqual([
      "droid-prompt.txt",
      "pass1-output.jsonl",
    ]);
    const copied = fs.readFileSync(
      path.join(debug, "pass1-output.jsonl"),
      "utf8",
    );
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(copied).not.toContain(value);
      expect(copied).toContain(`${name}=[REDACTED]`);
    }
  });

  it("redacts the Basic-encoded form of each credential", async () => {
    const { prompts, debug, env } = setup();
    const encoded = Buffer.from(`:${SECRETS.AZURE_DEVOPS_PAT}`).toString(
      "base64",
    );
    fs.writeFileSync(
      path.join(prompts, "pass1-output.jsonl"),
      `Authorization: Basic ${encoded}\n`,
    );
    await collect(env);
    const copied = fs.readFileSync(
      path.join(debug, "pass1-output.jsonl"),
      "utf8",
    );
    expect(copied).not.toContain(encoded);
    expect(copied).toContain("Authorization: Basic [REDACTED]");
  });

  it("skips symlinks the passes planted in the prompts directory", async () => {
    const { root, prompts, debug, env } = setup();
    const outside = path.join(root, "credentials");
    fs.writeFileSync(outside, "outside-secret-file");
    fs.symlinkSync(outside, path.join(prompts, "droid-error.txt"));
    const result = await collect(env);
    expect(result.skipped).toEqual([path.join(prompts, "droid-error.txt")]);
    expect(fs.existsSync(path.join(debug, "droid-error.txt"))).toBe(false);
  });
});
