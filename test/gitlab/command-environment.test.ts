import { describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeGitlabCommand } from "../../src/gitlab/operations/commands";

const modes: ("answer" | "fill" | "fix")[] = ["answer", "fill", "fix"];
const withheld = [
  "CI_REPOSITORY_URL",
  "GITLAB_TOKEN",
  "OVERRIDE_GITLAB_TOKEN",
  "CI_JOB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "INPUT_DROID_ARGS",
  "DROID_ARGS",
  "DROID_COMMAND_SAFE_SENTINEL",
  "DROID_COMMAND_ENV_PROBE",
  "FACTORY_SETTINGS_PATH",
  "FACTORY_MCP_CONFIG",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
];

function fakeCli(receipt: string, scenario: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-f") + 1];
const settingsPath = argv.includes("--settings") ? argv[argv.indexOf("--settings") + 1] : null;
const read = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
const body = fs.readFileSync(prompt, "utf8");
const output = path.join(path.dirname(prompt), "result.txt");
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
  argv, prompt, body, cwd: process.cwd(), home: process.env.HOME,
  settingsPath, settings: settingsPath ? read(settingsPath) : null,
  homeSettings: read(path.join(process.env.HOME, ".factory/settings.json")),
  cwdSettings: read(path.join(process.cwd(), ".factory/settings.json")),
  homeMcp: read(path.join(process.env.HOME, ".factory/mcp.json")),
  cwdMcp: read(path.join(process.cwd(), ".factory/mcp.json")),
  factory: process.env.FACTORY_API_KEY,
  env: Object.fromEntries(${JSON.stringify(withheld)}.map((key) => [key, process.env[key] ?? null])),
}));
const scenario = ${JSON.stringify(scenario)};
if (scenario === "nonzero") process.exit(7);
if (scenario === "missing") process.exit(0);
if (scenario === "symlink") fs.symlinkSync(prompt, output);
else if (scenario === "oversize") fs.truncateSync(fs.openSync(output, "w"), 32 * 1024 * 1024 + 1);
else if (scenario === "directory") fs.mkdirSync(output);
else fs.writeFileSync(output, "safe command output");
`;
}

async function fixture(
  scenario: string,
  test: (context: {
    directory: string;
    receipt: string;
    parent: Record<string, string>;
  }) => Promise<void>,
) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "droid-command-test-$'quoted-"),
  );
  const home = path.join(directory, "hostile-home");
  const cwd = path.join(directory, "hostile-cwd");
  const bin = path.join(directory, "bin");
  const receipt = path.join(directory, "receipt.json");
  const preload = path.join(directory, "hostile-preload.cjs");
  const preloadMarker = path.join(directory, "preload-executed");
  const parent: Record<string, string> = {
    ...Object.fromEntries(withheld.map((key) => [key, "fake-inherited-value"])),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    TMPDIR: directory,
    HOME: home,
    USERPROFILE: home,
    PWD: cwd,
    FACTORY_API_KEY: "fake-factory-auth-sentinel",
    CI_REPOSITORY_URL:
      "https://gitlab-ci-token:fake-job@gitlab.invalid/group/repo.git",
    NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
    BUN_OPTIONS: `--preload=${JSON.stringify(preload)}`,
  };
  const saved = Object.fromEntries(
    Object.keys(parent).map((key) => [key, process.env[key]]),
  );
  const oldCwd = process.cwd();
  for (const root of [home, cwd]) {
    await fs.mkdir(path.join(root, ".factory"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".factory/settings.json"),
      JSON.stringify({
        hooksDisabled: false,
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "hostile-startup-hook" }] },
          ],
        },
      }),
    );
    await fs.writeFile(
      path.join(root, ".factory/mcp.json"),
      '{"mcpServers":{"hostile":{"command":"hostile-mcp-server"}}}',
    );
  }
  await fs.mkdir(bin);
  await fs.writeFile(
    preload,
    `require("node:fs").writeFileSync(${JSON.stringify(preloadMarker)}, "inherited preload ran");`,
  );
  await fs.writeFile(path.join(bin, "droid"), fakeCli(receipt, scenario), {
    mode: 0o755,
  });
  Object.assign(process.env, parent);
  process.chdir(cwd);
  try {
    await test({ directory, receipt, parent });
  } finally {
    process.chdir(oldCwd);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

describe("GitLab command shared file-only configuration profile", () => {
  for (const mode of modes)
    it(`isolates hostile HOME/cwd/hooks/MCP/env and preserves only model auth for ${mode}`, async () => {
      await fixture("success", async ({ directory, receipt, parent }) => {
        expect(
          await executeGitlabCommand(
            "Explicit MR data, not checkout context.",
            mode,
          ),
        ).toBe("safe command output");
        const probe = JSON.parse(await fs.readFile(receipt, "utf8"));
        expect(probe.cwd).not.toBe(parent.PWD);
        expect(probe.home).not.toBe(parent.HOME);
        expect(path.isAbsolute(probe.cwd)).toBe(true);
        expect(path.isAbsolute(probe.prompt)).toBe(true);
        expect(path.dirname(probe.prompt)).toBe(probe.cwd);
        expect(path.dirname(probe.cwd)).toBe(path.dirname(probe.home));
        expect(probe.settingsPath).toBe(
          path.join(probe.cwd, ".factory/settings.json"),
        );
        expect(probe.settings).toEqual({ hooksDisabled: true });
        expect(probe.homeSettings).toEqual({ hooksDisabled: true });
        expect(probe.cwdSettings).toEqual({ hooksDisabled: true });
        expect(probe.homeMcp).toEqual({ mcpServers: {} });
        expect(probe.cwdMcp).toEqual({ mcpServers: {} });
        expect(probe.factory).toBe("fake-factory-auth-sentinel");
        // The old arbitrary benign-sentinel pass-through is intentionally gone.
        expect(probe.env).toEqual(
          Object.fromEntries(withheld.map((key) => [key, null])),
        );
        expect(probe.argv).toContain("--disable-builtin-skills");
        expect(probe.argv).not.toContain("--skip-permissions-unsafe");
        const tools =
          probe.argv[probe.argv.indexOf("--enabled-tools") + 1].split(",");
        expect(tools).toEqual([
          "Read",
          "Grep",
          "Glob",
          "LS",
          "Edit",
          "Create",
          "ApplyPatch",
        ]);
        expect(probe.argv[probe.argv.indexOf("--tag") + 1]).toBe(
          mode === "fix" ? "droid-fix" : "droid-question",
        );
        expect(probe.body).toContain("Explicit MR data, not checkout context.");
        expect(probe.body).toContain(
          mode === "fix" ? "JSON proposal" : "Markdown answer",
        );
        await expect(
          fs.stat(path.join(directory, "preload-executed")),
        ).rejects.toThrow();
        await expect(fs.stat(path.dirname(probe.cwd))).rejects.toThrow();
        expect(
          await fs.stat(path.join(directory, "hostile-home/.factory/mcp.json")),
        ).toBeDefined();
        for (const [key, value] of Object.entries(parent))
          expect(process.env[key]).toBe(value);
      });
    });

  for (const scenario of [
    "nonzero",
    "missing",
    "symlink",
    "oversize",
    "directory",
  ])
    it(`cleans its profile after ${scenario} output failure`, async () => {
      await fixture(scenario, async ({ receipt }) => {
        await expect(
          executeGitlabCommand("Only write the output file.", "fix"),
        ).rejects.toThrow();
        const probe = JSON.parse(await fs.readFile(receipt, "utf8"));
        await expect(fs.stat(path.dirname(probe.cwd))).rejects.toThrow();
      });
    });

  it("keeps argv shell-free and its ten-minute/buffer bounds on a timeout", async () => {
    await fixture("success", async ({ directory }) => {
      const before = await fs.readdir(directory);
      const spawn = spyOn(childProcess, "spawnSync").mockReturnValue({
        pid: 0,
        output: [],
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        status: null,
        signal: "SIGTERM",
        error: Object.assign(new Error("controlled timeout"), {
          code: "ETIMEDOUT",
        }),
      });
      try {
        await expect(
          executeGitlabCommand("Timeout input", "answer"),
        ).rejects.toThrow("Droid command execution failed");
        expect(spawn).toHaveBeenCalledWith(
          "droid",
          expect.arrayContaining(["exec", "--disable-builtin-skills"]),
          expect.objectContaining({
            shell: false,
            timeout: 10 * 60_000,
            maxBuffer: 1024 * 1024,
          }),
        );
        expect(await fs.readdir(directory)).toEqual(before);
      } finally {
        spawn.mockRestore();
      }
    });
  });

  it("does not mask its original command error when profile cleanup also fails", async () => {
    await fixture("nonzero", async ({ receipt }) => {
      const cleanup = spyOn(fs, "rm").mockImplementation(async () => {
        throw new Error("controlled cleanup failure");
      });
      let owned = "";
      try {
        await expect(
          executeGitlabCommand("Error input", "fix"),
        ).rejects.toThrow("Droid command execution failed");
        const probe = JSON.parse(await fs.readFile(receipt, "utf8"));
        owned = path.dirname(probe.cwd);
        expect(cleanup).toHaveBeenCalledWith(owned, {
          recursive: true,
          force: true,
        });
        expect(await fs.stat(owned)).toBeDefined();
      } finally {
        cleanup.mockRestore();
        if (owned) await fs.rm(owned, { recursive: true, force: true });
      }
    });
  });

  it("reports a cleanup error after otherwise successful command output", async () => {
    await fixture("success", async ({ receipt }) => {
      const cleanupError = new Error("controlled cleanup failure");
      const cleanup = spyOn(fs, "rm").mockImplementation(async () => {
        throw cleanupError;
      });
      let owned = "";
      try {
        await expect(
          executeGitlabCommand("Success input", "fill"),
        ).rejects.toBe(cleanupError);
        const probe = JSON.parse(await fs.readFile(receipt, "utf8"));
        owned = path.dirname(probe.cwd);
      } finally {
        cleanup.mockRestore();
        if (owned) await fs.rm(owned, { recursive: true, force: true });
      }
    });
  });
});
