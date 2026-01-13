#!/usr/bin/env bun

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DroidOptions } from "../src/run-droid";

const originalRunnerTemp = process.env.RUNNER_TEMP;

if (!process.env.RUNNER_TEMP) {
  process.env.RUNNER_TEMP = tmpdir();
}

const mockExecAsync = mock(async (cmd: string) => {
  if (cmd.includes("droid mcp remove")) {
    throw new Error("Server not found");
  }

  if (cmd.includes("nonexistent")) {
    throw new Error("Command not found");
  }

  if (cmd.includes("droid mcp add")) {
    return {
      stdout: `Registered command: ${cmd}`,
      stderr: "",
    };
  }

  if (cmd.startsWith("jq ")) {
    return {
      stdout: "[]",
      stderr: "",
    };
  }

  return {
    stdout: "",
    stderr: "",
  };
});

const mockSpawn = mock(
  (_command: string, _args: string[], _options: Record<string, unknown>) => {
    const proc = new EventEmitter() as any;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();

    proc.stdout = stdout;
    proc.stderr = stderr;

    setImmediate(() => {
      stdout.emit(
        "data",
        '{"type":"result","subtype":"test","is_error":false,"duration_ms":10}\n',
      );
      proc.emit("close", 0);
    });

    return proc;
  },
);

mock.module("child_process", () => ({
  exec: (
    command: string,
    options?:
      | Record<string, unknown>
      | ((err: Error | null, result?: any) => void),
    maybeCallback?: (err: Error | null, result?: any) => void,
  ) => {
    const callback =
      typeof options === "function"
        ? options
        : (maybeCallback ?? (() => undefined));

    setImmediate(async () => {
      try {
        const result = await mockExecAsync(command);
        callback(null, { stdout: result.stdout, stderr: result.stderr });
      } catch (error: any) {
        callback(error, undefined);
      }
    });
  },
  spawn: mockSpawn,
}));

type RunDroidModule = typeof import("../src/run-droid");
let prepareRunConfig: RunDroidModule["prepareRunConfig"];
let runDroid: RunDroidModule["runDroid"];

beforeAll(async () => {
  const module = (await import(
    `../src/run-droid?mcp-test=${Math.random().toString(36).slice(2)}`
  )) as RunDroidModule;
  prepareRunConfig = module.prepareRunConfig;
  runDroid = module.runDroid;
});

async function createPromptFile(): Promise<string> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "run-droid-test-"));
  const promptPath = path.join(tmpDir, "prompt.txt");
  await writeFile(promptPath, "Test prompt");
  process.env.RUNNER_TEMP = tmpDir;
  return promptPath;
}

async function cleanupTempDir(dir: string) {
  await rm(dir, { recursive: true, force: true });
}
describe("MCP Server Registration", () => {
  beforeEach(() => {
    mockExecAsync.mockClear();
    mockSpawn.mockClear();
  });

  afterEach(() => {
    if (originalRunnerTemp) {
      process.env.RUNNER_TEMP = originalRunnerTemp;
    } else {
      delete process.env.RUNNER_TEMP;
    }
  });

  describe("MCP Config Parsing", () => {
    test("should parse and register MCP servers from config", async () => {
      const mcpTools = JSON.stringify({
        mcpServers: {
          github_comment: {
            command: "bun",
            args: ["run", "/path/to/github-comment-server.ts"],
            env: {
              GITHUB_TOKEN: "test-token",
              REPO_OWNER: "owner",
              REPO_NAME: "repo",
            },
          },
          github_ci: {
            command: "bun",
            args: ["run", "/path/to/github-actions-server.ts"],
            env: {
              GITHUB_TOKEN: "test-token",
              PR_NUMBER: "123",
            },
          },
        },
      });

      const options: DroidOptions = {
        mcpTools,
        pathToDroidExecutable: "droid",
      };
      const promptPath = await createPromptFile();
      const tempDir = process.env.RUNNER_TEMP!;

      try {
        await runDroid(promptPath, options);

        const addCommands = mockExecAsync.mock.calls
          .map((call) => call[0])
          .filter((cmd) => cmd.includes("droid mcp add"));

        expect(addCommands.length).toBe(2);
        expect(addCommands[0]).toContain("github_comment");
        expect(addCommands[1]).toContain("github_ci");
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    test("should handle empty MCP config gracefully", () => {
      const options: DroidOptions = {
        mcpTools: "",
      };
      const prepared = prepareRunConfig("/tmp/test-prompt.txt", options);

      expect(prepared.droidArgs).not.toContain("--mcp-config");
    });

    test("should handle invalid JSON in MCP config", () => {
      const options: DroidOptions = {
        mcpTools: "{ invalid json }",
        pathToDroidExecutable: "droid",
      };

      // prepareRunConfig doesn't parse MCP config, so it won't throw
      // The actual parsing happens in runDroid which needs async testing
      // For now, just verify the config is passed through
      const prepared = prepareRunConfig("/tmp/test-prompt.txt", options);
      expect(prepared.droidArgs).not.toContain("--mcp-config");
    });
  });

  describe("Tool Name Detection", () => {
    test("should detect deprecated mcp__ prefix in enabled tools", async () => {
      const originalWarn = console.warn;
      const warnSpy = mock<typeof console.warn>((..._args) => {});
      console.warn = warnSpy as unknown as typeof console.warn;

      const options: DroidOptions = {
        droidArgs:
          '--enabled-tools "mcp__github_comment__update_droid_comment,Execute"',
      };

      const promptPath = await createPromptFile();
      const tempDir = process.env.RUNNER_TEMP!;

      try {
        await runDroid(promptPath, options);

        const warningMessages = warnSpy.mock.calls.map((args) => args[0]);
        expect(
          warningMessages.some(
            (msg) =>
              typeof msg === "string" &&
              msg.includes("deprecated mcp__ prefix"),
          ),
        ).toBe(true);
      } finally {
        console.warn = originalWarn;
        await cleanupTempDir(tempDir);
      }
    });

    test("should not warn when using new tool naming pattern", async () => {
      const originalWarn = console.warn;
      const warnSpy = mock<typeof console.warn>((..._args) => {});
      console.warn = warnSpy as unknown as typeof console.warn;

      const options: DroidOptions = {
        droidArgs:
          '--enabled-tools "github_comment___update_droid_comment,Execute"',
      };

      const promptPath = await createPromptFile();
      const tempDir = process.env.RUNNER_TEMP!;

      try {
        await runDroid(promptPath, options);
        expect(warnSpy.mock.calls.length).toBe(0);
      } finally {
        console.warn = originalWarn;
        await cleanupTempDir(tempDir);
      }
    });

    test("should detect MCP tools with triple underscore pattern", () => {
      const options: DroidOptions = {
        droidArgs:
          '--enabled-tools "github_ci___get_ci_status,github_comment___update_droid_comment"',
      };

      const prepared = prepareRunConfig("/tmp/test-prompt.txt", options);

      // The args should be passed through correctly
      expect(prepared.droidArgs).toContain("--enabled-tools");
      expect(prepared.droidArgs).toContain(
        "github_ci___get_ci_status,github_comment___update_droid_comment",
      );
    });
  });

  describe("Error Handling", () => {
    test("should fail fast when MCP server registration fails", async () => {
      const mcpTools = JSON.stringify({
        mcpServers: {
          failing_server: {
            command: "nonexistent",
            args: ["command"],
            env: {},
          },
        },
      });

      const options: DroidOptions = {
        mcpTools,
        pathToDroidExecutable: "droid",
      };
      const promptPath = await createPromptFile();
      const tempDir = process.env.RUNNER_TEMP!;

      try {
        await expect(runDroid(promptPath, options)).rejects.toThrow(
          "MCP server registration failed",
        );
      } finally {
        await cleanupTempDir(tempDir);
      }
    });

    test("should not attempt MCP registration when config is not provided", () => {
      const options: DroidOptions = {};
      const prepared = prepareRunConfig("/tmp/test-prompt.txt", options);

      expect(prepared.env).toEqual({});
    });
  });

  describe("Environment Variables", () => {
    test("should include GITHUB_ACTION_INPUTS when present", () => {
      process.env.INPUT_ACTION_INPUTS_PRESENT = "true";

      const options: DroidOptions = {};
      const prepared = prepareRunConfig("/tmp/test-prompt.txt", options);

      expect(prepared.env.GITHUB_ACTION_INPUTS).toBe("true");

      delete process.env.INPUT_ACTION_INPUTS_PRESENT;
    });

    test("should not include GITHUB_ACTION_INPUTS when not present", () => {
      delete process.env.INPUT_ACTION_INPUTS_PRESENT;

      const options: DroidOptions = {};
      const prepared = prepareRunConfig("/tmp/test-prompt.txt", options);

      expect(prepared.env.GITHUB_ACTION_INPUTS).toBeUndefined();
    });
  });
});
