import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { createCommandProfile } from "../src/command-profile";
import { buildDroidEnv } from "../src/run-droid";
import { redactCredentials } from "../src/utils/redact-credentials";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("file-only command CLI profile isolation", () => {
  it("creates a clean HOME/cwd with hooks disabled and empty MCP configuration", async () => {
    const profile = await createCommandProfile("fix", {
      HOME: "/untrusted-home",
      USERPROFILE: "/untrusted-profile",
      PATH: process.env.PATH,
      FACTORY_API_KEY: "test-factory-key",
      GITHUB_TOKEN: "test-github-token",
      WORKFLOW_GITHUB_TOKEN: "workflow-secret",
      NODE_OPTIONS: "--require untrusted.js",
      BUN_OPTIONS: "--preload evil.ts",
      FACTORY_PROJECT_DIR: "/untrusted-project",
      COMMAND_EXPECTED_HEAD: "forged",
    });
    cleanup.push(dirname(profile.cwd));
    expect(profile.env.HOME).not.toBe("/untrusted-home");
    expect(profile.cwd).toStartWith(tmpdir());
    expect(profile.env.FACTORY_API_KEY).toBe("test-factory-key");
    for (const key of [
      "GITHUB_TOKEN",
      "WORKFLOW_GITHUB_TOKEN",
      "NODE_OPTIONS",
      "BUN_OPTIONS",
      "FACTORY_PROJECT_DIR",
      "COMMAND_EXPECTED_HEAD",
    ])
      expect(profile.env[key]).toBeUndefined();
    expect(
      JSON.parse(
        await readFile(
          join(profile.env.HOME!, ".factory/settings.json"),
          "utf8",
        ),
      ),
    ).toEqual({ hooksDisabled: true });
    expect(
      JSON.parse(
        await readFile(join(profile.cwd, ".factory/mcp.json"), "utf8"),
      ),
    ).toEqual({ mcpServers: {} });
    expect(profile.args).toContain("--settings");
    expect(profile.args).toContain("--disable-builtin-skills");
    expect(profile.args).not.toContain("Execute");
  });

  it("runs the base-action from a neutral profile without merging stale hooks/settings/MCP or user args", async () => {
    const dir = await mkdtemp(join(tmpdir(), "command-profile-test-"));
    cleanup.push(dir);
    const home = join(dir, "old-home");
    const work = join(dir, "old-project");
    await Promise.all([
      mkdir(join(home, ".factory"), { recursive: true }),
      mkdir(join(work, ".factory"), { recursive: true }),
    ]);
    for (const root of [home, work]) {
      await writeFile(
        join(root, ".factory/settings.json"),
        '{"hooksDisabled":false,"hooks":{"SessionStart":[{"hooks":[{"command":"malicious hook"}]}]}}',
      );
      await writeFile(
        join(root, ".factory/mcp.json"),
        '{"mcpServers":{"old":{"command":"malicious server","env":{"TOKEN":"old-secret"}}}}',
      );
    }
    const prompt = join(dir, "prompt.txt");
    const dump = join(dir, "startup.json");
    const fake = join(dir, "fake-droid");
    await writeFile(prompt, "Read the absolute context and write an answer.");
    await writeFile(
      fake,
      `#!${process.execPath}
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
const settings = JSON.parse(readFileSync(join(process.env.HOME, ".factory/settings.json"), "utf8"));
const mcp = JSON.parse(readFileSync(join(process.cwd(), ".factory/mcp.json"), "utf8"));
writeFileSync(${JSON.stringify(dump)}, JSON.stringify({env:process.env,cwd:process.cwd(),args:process.argv.slice(2),settings,mcp}));
console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,duration_ms:1}));
`,
    );
    await chmod(fake, 0o700);
    const runner = Bun.spawn(
      [
        process.execPath,
        "--config=/dev/null",
        "--env-file=/dev/null",
        "run",
        join(import.meta.dir, "../src/index.ts"),
      ],
      {
        cwd: work,
        env: {
          ...process.env,
          HOME: home,
          FACTORY_API_KEY: "synthetic-factory-key",
          GITHUB_TOKEN: "synthetic-github-token",
          WORKFLOW_GITHUB_TOKEN: "synthetic-workflow-token",
          INPUT_PROMPT_FILE: prompt,
          INPUT_SETTINGS: '{"hooksDisabled":false}',
          INPUT_MCP_TOOLS: '{"mcpServers":{"bad":{"command":"false"}}}',
          INPUT_DROID_ARGS:
            "--enabled-tools Execute --settings /untrusted.json",
          INPUT_PATH_TO_DROID_EXECUTABLE: fake,
          DROID_COMMAND_MODE: "question",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(runner.stdout).text(),
      new Response(runner.stderr).text(),
      runner.exited,
    ]);
    expect(exit).toBe(0);
    expect(stderr).not.toContain("synthetic");
    expect(stdout).not.toContain("Registering");
    const captured = JSON.parse(await readFile(dump, "utf8"));
    cleanup.push(dirname(captured.cwd));
    expect(captured.cwd).not.toBe(work);
    expect(captured.env.HOME).not.toBe(home);
    expect(captured.settings).toEqual({ hooksDisabled: true });
    expect(captured.mcp).toEqual({ mcpServers: {} });
    expect(captured.env.GITHUB_TOKEN).toBeUndefined();
    expect(captured.env.WORKFLOW_GITHUB_TOKEN).toBeUndefined();
    expect(captured.args).toContain("Read,Grep,Glob,LS,Edit,Create,ApplyPatch");
    expect(captured.args).not.toContain("Execute");
    expect(captured.args).not.toContain("/untrusted.json");
    expect(captured.args).toContain(prompt);
  });

  it("withholds check credentials and publisher authority from normal model environments too", () => {
    const env = buildDroidEnv(
      {
        PATH: "/bin",
        WORKFLOW_GITHUB_TOKEN: "arbitrary-workflow-secret",
        COMMAND_ACTOR: "actor",
        COMMAND_PUBLISHER_SHA256: "digest",
      },
      {},
    );
    expect(env).toEqual({ PATH: "/bin" });
    expect(
      redactCredentials("failed arbitrary-workflow-secret", {
        WORKFLOW_GITHUB_TOKEN: "arbitrary-workflow-secret",
      }),
    ).toBe("failed [REDACTED]");
  });
});
