import { afterEach, describe, expect, it } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { createCommandProfile } from "../src/command-profile";
import { buildDroidEnv } from "../src/run-droid";
import { redactCredentials } from "../src/utils/redact-credentials";
import { parse } from "shell-quote";

const cleanup: string[] = [];
const fakeCliEnvironment = {
  PATH: "/dev/null",
  FACTORY_API_KEY: "synthetic-factory-key",
  FACTORY_API_BASE_URL: "http://127.0.0.1:9",
  FACTORY_API_URL: "http://127.0.0.1:9",
  HTTP_PROXY: "",
  HTTPS_PROXY: "",
  http_proxy: "",
  https_proxy: "",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
  NODE_OPTIONS: "",
  BUN_OPTIONS: "",
  NODE_PATH: "",
  ACTIONS_STEP_DEBUG: "false",
};
function childStartupEnvironment(home: string) {
  return {
    ...fakeCliEnvironment,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: dirname(home),
    TMP: dirname(home),
    TEMP: dirname(home),
    RUNNER_TEMP: dirname(home),
  };
}
async function withEnvironment<T>(
  env: NodeJS.ProcessEnv,
  run: () => Promise<T>,
) {
  const previous: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("file-only command CLI profile isolation", () => {
  it("creates a clean HOME/cwd with hooks disabled and empty MCP configuration", async () => {
    const profile = await withEnvironment(
      {
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
      },
      () => createCommandProfile("fix"),
    );
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
    expect(parse(profile.args)).toEqual(Array.from(profile.argv ?? []));
    expect(profile.argv).toEqual([
      "--cwd",
      profile.cwd,
      "--settings",
      join(profile.cwd, ".factory/settings.json"),
      "--disable-builtin-skills",
      "--enabled-tools",
      "Read,Grep,Glob,LS,Edit,Create,ApplyPatch",
      "--tag",
      "droid-fix",
    ]);
  });

  it("cleans its own profile idempotently without removing caller-owned output", async () => {
    const outside = await mkdtemp(
      join(tmpdir(), "profile output space ' \" $VECTOR `vector` \\ -"),
    );
    cleanup.push(outside);
    await writeFile(join(outside, "keep.txt"), "caller output");
    const profile = await withEnvironment(
      { TMPDIR: outside, TMP: outside, TEMP: outside },
      () => createCommandProfile("question"),
    );
    const root = dirname(profile.cwd);
    cleanup.push(root);
    if ("cleanup" in profile && typeof profile.cleanup === "function") {
      await profile.cleanup();
      await profile.cleanup();
    }
    expect(await exists(root)).toBe(false);
    expect(parse(profile.args)).toEqual(Array.from(profile.argv ?? []));
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe(
      "caller output",
    );
  });

  it.each([false, true])(
    "preserves the original settings setup error when cleanup failure is %s",
    async (cleanupFails) => {
      const parent = await mkdtemp(join(tmpdir(), "profile-setup-failure-"));
      cleanup.push(parent);
      await writeFile(join(parent, "keep.txt"), "caller output");
      const stdoutPath = join(parent, "child.stdout.log");
      const stderrPath = join(parent, "child.stderr.log");
      const [stdoutFile, stderrFile] = await Promise.all([
        open(stdoutPath, "w"),
        open(stderrPath, "w"),
      ]);
      console.log("Setup-fault child logs:", stdoutPath, stderrPath);
      // Keep the native-module mock in a separate process, never other tests.
      let exit: number;
      try {
        const child = Bun.spawn(
          [
            process.execPath,
            "--config=/dev/null",
            "--env-file=/dev/null",
            "--eval",
            `import { mock } from "bun:test";
const actual = { ...await import("fs/promises") };
const primary = new Error("profile setup refused");
let cleanupAttempts = 0;
mock.module("fs/promises", () => ({
  ...actual,
  writeFile: async () => { throw primary; },
  rm: async (...args) => {
    cleanupAttempts++;
    if (${cleanupFails}) throw new Error("profile cleanup refused");
    return actual.rm(...args);
  },
}));
const { createCommandProfile } = await import(${JSON.stringify(join(import.meta.dir, "../src/command-profile.ts"))});
try {
  await createCommandProfile("fix");
  process.exitCode = 2;
} catch (error) {
  if (error !== primary) throw new Error("Original setup error was replaced");
  console.log(JSON.stringify({message:error.message,cleanupAttempts}));
}`,
          ],
          {
            env: {
              ...childStartupEnvironment(join(parent, "startup-home")),
              TMPDIR: parent,
              TMP: parent,
              TEMP: parent,
            },
            stdout: stdoutFile.fd,
            stderr: stderrFile.fd,
          },
        );
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        try {
          exit = await child.exited;
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null) {
            child.kill("SIGKILL");
            await child.exited;
          }
        }
      } finally {
        await Promise.all([stdoutFile.close(), stderrFile.close()]);
      }
      const [stdout, stderr] = await Promise.all([
        readFile(stdoutPath, "utf8"),
        readFile(stderrPath, "utf8"),
      ]);
      if (exit !== 0)
        throw new Error(
          `Setup-fault child exited ${exit}:\n${stdout}\n${stderr}`,
        );
      expect(exit).toBe(0);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout.trim())).toEqual({
        message: "profile setup refused",
        cleanupAttempts: 1,
      });
      const roots = (await readdir(parent)).filter((name) =>
        name.startsWith("droid-command-profile-"),
      );
      expect(roots).toHaveLength(cleanupFails ? 1 : 0);
      expect(await readFile(join(parent, "keep.txt"), "utf8")).toBe(
        "caller output",
      );
    },
    10000,
  );

  it("cleans the profile when prompt preparation fails before Exec", async () => {
    const parent = await mkdtemp(join(tmpdir(), "profile-prompt-failure-"));
    cleanup.push(parent);
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--config=/dev/null",
        "--env-file=/dev/null",
        join(import.meta.dir, "../src/index.ts"),
      ],
      {
        env: {
          ...childStartupEnvironment(join(parent, "startup-home")),
          INPUT_PATH_TO_DROID_EXECUTABLE: join(parent, "must-not-execute"),
          DROID_COMMAND_MODE: "question",
          INPUT_PROMPT: "",
          INPUT_PROMPT_FILE: join(parent, "missing-prompt.txt"),
          TMPDIR: parent,
          TMP: parent,
          TEMP: parent,
          RUNNER_TEMP: parent,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [, , exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(1);
    expect(
      (await readdir(parent)).filter((name) =>
        name.startsWith("droid-command-profile-"),
      ),
    ).toEqual([]);
  });

  it.each([0, 42])(
    "cleans the base-action neutral profile after Exec exit %i without merging stale configuration",
    async (exitCode) => {
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
console.log(JSON.stringify(${JSON.stringify(
          exitCode
            ? {
                type: "error",
                source: "agent_loop",
                message:
                  '402 {"detail":"test usage limit synthetic-workflow-token"}',
              }
            : {
                type: "result",
                subtype: "success",
                is_error: false,
                duration_ms: 1,
              },
        )}));
process.exit(${exitCode});
`,
      );
      await chmod(fake, 0o700);
      const runner = Bun.spawn(
        [
          process.execPath,
          "run",
          "--config=/dev/null",
          "--env-file=/dev/null",
          join(import.meta.dir, "../src/index.ts"),
        ],
        {
          cwd: work,
          env: {
            ...childStartupEnvironment(home),
            GITHUB_TOKEN: "synthetic-github-token",
            WORKFLOW_GITHUB_TOKEN: "synthetic-workflow-token",
            INPUT_PROMPT_FILE: prompt,
            INPUT_SETTINGS: '{"hooksDisabled":false}',
            INPUT_MCP_TOOLS: '{"mcpServers":{"bad":{"command":"false"}}}',
            INPUT_DROID_ARGS:
              "--enabled-tools Execute --settings /untrusted.json",
            INPUT_PATH_TO_DROID_EXECUTABLE: fake,
            DROID_COMMAND_MODE: "question",
            INPUT_SHOW_FULL_OUTPUT: "false",
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
      expect(exit).toBe(exitCode);
      expect(stderr).not.toContain("synthetic");
      expect(stdout).not.toContain("Registering");
      expect(stdout).not.toContain("synthetic-workflow-token");
      const captured = JSON.parse(await readFile(dump, "utf8"));
      cleanup.push(dirname(captured.cwd));
      expect(captured.cwd).not.toBe(work);
      expect(captured.env.HOME).not.toBe(home);
      expect(captured.settings).toEqual({ hooksDisabled: true });
      expect(captured.mcp).toEqual({ mcpServers: {} });
      expect(captured.env.GITHUB_TOKEN).toBeUndefined();
      expect(captured.env.WORKFLOW_GITHUB_TOKEN).toBeUndefined();
      expect(captured.args).toContain(
        "Read,Grep,Glob,LS,Edit,Create,ApplyPatch",
      );
      expect(captured.args).not.toContain("Execute");
      expect(captured.args).not.toContain("/untrusted.json");
      expect(captured.args).toContain(prompt);
      expect(await exists(dirname(captured.cwd))).toBe(false);
      expect(
        JSON.parse(await readFile(join(home, ".factory/settings.json"), "utf8"))
          .hooksDisabled,
      ).toBe(false);
    },
  );

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
