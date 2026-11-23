import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse } from "yaml";
import { createControlledRuntime } from "./helpers/controlled-runtime";

const manifest = parse(
  readFileSync(join(import.meta.dir, "../action.yml"), "utf8"),
);
const post = manifest.runs.steps.find(
  (step: { name?: string }) => step.name === "Publish Droid command result",
);
const model = manifest.runs.steps.find(
  (step: { id?: string }) => step.id === "droid",
);
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

async function executeGuard(tamper: "none" | "publisher" | "runtime") {
  directory = await mkdtemp(join(tmpdir(), "publisher-guard-"));
  const publisher = join(directory, "publisher.mjs");
  const output = join(directory, "published");
  const fakeBin = join(directory, "poisoned-path");
  await mkdir(fakeBin);
  const poison = join(fakeBin, "bun");
  await writeFile(poison, "#!/bin/sh\nexit 99\n");
  await chmod(poison, 0o700);
  const hook = join(directory, "untrusted-startup");
  await writeFile(hook, `echo unsafe-startup-hook; exit 98\n`);
  const source = Buffer.from(
    `import {writeFileSync} from "fs"; writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env));`,
  );
  await writeFile(
    publisher,
    tamper === "publisher"
      ? Buffer.from("throw Error('untrusted publisher ran')")
      : source,
  );
  const runtime = await createControlledRuntime(directory);
  const script = join(directory, "publish.sh");
  await writeFile(script, post.run);
  const safetyEnv = Object.fromEntries(
    Object.entries(post.env).filter(([, value]) => value === ""),
  );
  const child = Bun.spawn([...post.shell.split(" ").slice(0, -1), script], {
    cwd: directory,
    env: {
      ...runtime.env,
      PATH: fakeBin,
      BASH_ENV: hook,
      HTTPS_PROXY: "https://untrusted.invalid",
      NODE_EXTRA_CA_CERTS: "/untrusted-cert",
      BUN_CONFIG_VERBOSE_FETCH: "true",
      ...safetyEnv,
      GITHUB_TOKEN: "synthetic-only",
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_SERVER_URL: "https://github.com",
      COMMAND_MODE: "fix",
      COMMAND_OUTPUT_PATH: output,
      COMMAND_EXPECTED_HEAD: "a".repeat(40),
      COMMAND_FIX_MODE: "commit",
      COMMAND_ROOT_COMMENT_ID: "",
      COMMAND_PR_NUMBER: "3",
      COMMAND_ACTOR: "synthetic-actor",
      REPO_OWNER: "synthetic-owner",
      REPO_NAME: "synthetic-repo",
      DROID_SUCCESS: "true",
      COMMAND_PUBLISHER_PATH: publisher,
      COMMAND_PUBLISHER_SHA256: hash(source),
      COMMAND_RUNTIME_PATH: runtime.path,
      COMMAND_RUNTIME_SHA256:
        tamper === "runtime" ? "0".repeat(64) : runtime.sha256,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { output, stdout, stderr, exit };
}

describe("command publisher immutable workflow boundary", () => {
  it("does not expose unused publisher outputs or retain a dead step ID", () => {
    expect(post.id).toBeUndefined();
    expect(post.run).not.toContain("GITHUB_OUTPUT");
    expect(
      readFileSync(
        join(import.meta.dir, "../src/entrypoints/github-post-command.ts"),
        "utf8",
      ),
    ).not.toContain("core.setOutput");
  });
  it("binds post authority to prepare outputs, not a mutable state JSON", () => {
    for (const name of [
      "MODE",
      "OUTPUT_PATH",
      "EXPECTED_HEAD",
      "FIX_MODE",
      "ROOT_COMMENT_ID",
      "PR_NUMBER",
      "ACTOR",
      "PUBLISHER_PATH",
      "PUBLISHER_SHA256",
      "RUNTIME_PATH",
      "RUNTIME_SHA256",
    ]) {
      expect(post.env[`COMMAND_${name}`]).toBe(
        `\${{ steps.prepare.outputs.command_${name.toLowerCase()} }}`,
      );
    }
    expect(post.env.REPO_OWNER).toBe("${{ github.repository_owner }}");
    expect(post.env.REPO_NAME).toBe("${{ github.event.repository.name }}");
    expect(post.env.FACTORY_API_KEY).toBeUndefined();
    expect(post.run).not.toContain("github-post-command.ts");
  });
  it("withholds tokens, inherited settings and MCP from file-only model modes", () => {
    expect(model.env.GITHUB_TOKEN).toContain("command_mode == ''");
    expect(model.env.INPUT_MCP_TOOLS).toContain("command_mode == ''");
    expect(model.env.INPUT_SETTINGS).toContain("command_mode != '' && '{}'");
    expect(model.env.DROID_COMMAND_MODE).toBe(
      "${{ steps.prepare.outputs.command_mode }}",
    );
    expect(model.env.WORKFLOW_GITHUB_TOKEN).toBeUndefined();
  });
  it("executes only the verified absolute runtime despite a poisoned PATH", async () => {
    const result = await executeGuard("none");
    expect(result.exit).toBe(0);
    const captured = JSON.parse(await readFile(result.output, "utf8"));
    expect(captured.GITHUB_TOKEN).toBe("synthetic-only");
    expect(captured.PATH).toBe("/usr/bin:/bin");
    for (const key of [
      "BASH_ENV",
      "HTTPS_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "BUN_CONFIG_VERBOSE_FETCH",
    ])
      expect(captured[key]).toBeUndefined();
    expect(result.stdout).not.toContain("unsafe-startup-hook");
  });
  it.each(["publisher", "runtime"] as const)(
    "refuses a changed %s before executing the publisher",
    async (tamper) => {
      const result = await executeGuard(tamper);
      expect(result.exit).toBe(1);
      expect(result.stdout).toContain("refusing to publish");
      await expect(readFile(result.output, "utf8")).rejects.toThrow();
      expect(result.stderr).not.toContain("untrusted publisher ran");
    },
  );
});
